"use client";

import { useLayoutEffect, useRef } from 'react';
import type { CollaborationProjectUpdate } from '../types';
import { hasCompetingUpdateUi } from '../lib/useRemoteProjectUpdates';

export default function RemoteProjectUpdateDialog({ update, recovery, onClose }: {
  update: CollaborationProjectUpdate; recovery: boolean; onClose: (shown: CollaborationProjectUpdate) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Other portals can mount in the same commit. Never steal their focus.
    if (hasCompetingUpdateUi()) { if (root.current) root.current.hidden = true; return; }
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus({ preventScroll: true });
    // A safety/overlay suspension is not Close and must not restore focus.
  }, []);
  const close = () => {
    onClose(update);
    const target = origin.current;
    if (!hasCompetingUpdateUi() && target?.isConnected && target.getClientRects().length && getComputedStyle(target).visibility !== 'hidden') target.focus({ preventScroll: true });
  };
  return <div ref={root} className="modal-backdrop remote-project-update-backdrop" data-remote-update-root="true">
    <section className="remote-project-update-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-project-update-title" aria-describedby="remote-project-update-message"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); }
      }}>
      <h2 id="remote-project-update-title">Project updated</h2>
      <p id="remote-project-update-message">{update.lastUpdatedBy?.displayName || 'Another user'} updated this project at {new Date(update.updatedAt).toLocaleString('en-GB')}. Press F5 to reload the latest data.</p>
      {recovery && <p>Review any local drafts in Save and Recovery before reloading.</p>}
      <button ref={button} type="button" className="btn btn-secondary" onClick={close}>Close</button>
    </section>
  </div>;
}
