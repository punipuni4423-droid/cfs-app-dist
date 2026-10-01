'use client';

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { databaseOperationSnapshot, databaseOperationServerSnapshot, isDatabaseOperationBusy, subscribeDatabaseOperation } from '../lib/databaseOperation';

export default function DatabaseOperationOverlay() {
  const operation = useSyncExternalStore(subscribeDatabaseOperation, databaseOperationSnapshot, databaseOperationServerSnapshot);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const block = (event: Event) => {
      if (!isDatabaseOperationBusy()) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'submit', 'wheel', 'touchstart', 'touchmove'];
    events.forEach(name => window.addEventListener(name, block, { capture: true, passive: false }));
    const focus = (event: FocusEvent) => {
      if (!isDatabaseOperationBusy() || !dialogRef.current?.open || dialogRef.current.contains(event.target as Node)) return;
      event.stopImmediatePropagation();
      dialogRef.current.focus({ preventScroll: true });
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!isDatabaseOperationBusy()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('focusin', focus, true);
    window.addEventListener('beforeunload', leave);
    return () => {
      events.forEach(name => window.removeEventListener(name, block, true));
      window.removeEventListener('focusin', focus, true);
      window.removeEventListener('beforeunload', leave);
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!operation || !dialog) return;
    // Native top layer also covers SettingsMenu, comboboxes and other body portals.
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      dialog.close();
      requestAnimationFrame(() => {
        if (isDatabaseOperationBusy()) return;
        const opener = operation.opener;
        const usable = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected && !element.closest('[inert]') && !element.matches(':disabled') && element.getClientRects().length > 0);
        const target = usable(opener) ? opener : Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), main button:not(:disabled), .app-shell button:not(:disabled)')).find(usable);
        target?.focus({ preventScroll: true });
      });
    };
  }, [operation]);

  if (!operation || typeof document === 'undefined') return null;
  return createPortal(<dialog ref={dialogRef} className="database-operation-overlay" tabIndex={-1}
    aria-labelledby="database-operation-title" aria-describedby="database-operation-description"
    onCancel={event => event.preventDefault()} data-testid="database-operation-overlay">
    <div className="database-operation-spinner" aria-hidden="true" />
    <div role="status" aria-live="polite" aria-atomic="true">
      <h2 id="database-operation-title">{operation.label}</h2>
      <p id="database-operation-description">Please wait until this operation is complete.</p>
    </div>
  </dialog>, document.body);
}
