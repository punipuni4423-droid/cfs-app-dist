'use client';
import { useState } from 'react';
import type { ProjectData } from '../types';
import { finiteFetch, saveError } from '../lib/projectSaveProtocol';
import type { ProjectBase, RestoreSource } from '../lib/projectBase';

interface HistoryItem { id: string; version: number; parentVersion: number | null; operation: string; actorName: string; createdAt: string; snapshotSha256: string; restoredFrom?: unknown }
export interface RestorePreview { project: ProjectData; base: ProjectBase; restoreSource: RestoreSource; before: ProjectData; ownerEpoch: number }
export default function ServerHistoryPanel({ projectId, accessToken, canRestore, onRestore }: {
  projectId: string; accessToken: string; canRestore: boolean; onRestore: (source: RestoreSource) => void;
}) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (more = false) => {
    setBusy(true); setError('');
    try {
      const response = await finiteFetch(`/api/projects/history?projectId=${encodeURIComponent(projectId)}${more && next ? `&beforeVersion=${next}` : ''}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw saveError(response.status, body.code);
      if (!Array.isArray(body.items)) throw new Error('The history list could not be verified.');
      setItems(old => more ? [...(old ?? []), ...body.items] : body.items);
      setNext(body.nextBeforeVersion ?? null);
    } catch (err) { setError(err instanceof Error ? err.message : 'History could not be loaded.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Server History">
    <h3>Server History</h3>
    <p>Automatic copies captured before each shared change. Named revisions are kept separately.</p>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void load()}>Load Server History</button>
    {error && <p role="alert">{error}</p>}
    {items?.length === 0 && <p>No automatic history is available yet.</p>}
    {items?.map(item => <div key={item.id} className="recovery-record">
      <p>Version {item.version} · {item.createdAt} · {item.operation} · {item.actorName || 'Unknown actor'}</p>
      <small>SHA-256: {item.snapshotSha256}</small><br />
      <button className="btn btn-secondary" disabled={!canRestore} onClick={() => onRestore({ kind: 'history', id: item.id })}>Preview Restore…</button>
    </div>)}
    {next !== null && <button className="btn btn-secondary" disabled={busy} onClick={() => void load(true)}>Load older history</button>}
    {!canRestore && <p>Obtain edit access before restoring.</p>}
  </section>;
}

export function RestorePreviewDialog({ preview, busy, onConfirm, onCancel }: {
  preview: RestorePreview; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const rows: [string, string | number, string | number][] = [
    ['Project', preview.before.name, preview.project.name],
    ['Room types', preview.before.roomTypes.length, preview.project.roomTypes.length],
    ['Circuits', preview.before.circuits.length, preview.project.circuits.length],
    ['Areas', preview.before.locations.length, preview.project.locations.length],
    ['Fixtures', preview.before.fixtures.length, preview.project.fixtures.length],
    ['Remarks', preview.before.remarks?.length ?? 0, preview.project.remarks?.length ?? 0],
  ];
  return <div className="modal-backdrop edit-finish-backdrop">
    <section className="edit-finish-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-preview-title" style={{ maxHeight: '90vh', overflowY: 'auto', maxWidth: 'calc(100vw - 32px)' }}>
      <h2 id="restore-preview-title">Restore Revision…</h2>
      <p>This will save a new shared version based on version {preview.base.version}. The current named revision history will be kept. Your unsaved changes will be retained in Recovery.</p>
      <table style={{ width: '100%', marginBottom: 16 }}><thead><tr><th scope="col">Contents</th><th scope="col">Current</th><th scope="col">Restore</th></tr></thead>
        <tbody>{rows.map(([label, current, restored]) => <tr key={label}><th scope="row">{label}</th><td>{current}</td><td>{restored}</td></tr>)}</tbody></table>
      <details><summary>Preview complete restored contents</summary><pre style={{ maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview.project, null, 2)}</pre></details>
      <div className="edit-finish-actions" style={{ position: 'sticky', bottom: -1, background: 'white', paddingTop: 12 }}>
        <button className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={onConfirm}>{busy ? 'Saving restore…' : 'Confirm Restore as New Version'}</button>
      </div>
    </section>
  </div>;
}
