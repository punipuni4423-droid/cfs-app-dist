/** One logical foreground operation per browser tab. Background drafts/heartbeats do not acquire it. */
export type DatabaseOperation = Readonly<{ id: symbol; label: string; opener: HTMLElement | null }>;
let active: DatabaseOperation | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export const databaseOperationSnapshot = (): DatabaseOperation | null => active;
export const databaseOperationServerSnapshot = (): null => null;
export const isDatabaseOperationBusy = (): boolean => active !== null;
export const ownsDatabaseOperation = (operation?: DatabaseOperation | null): boolean => Boolean(operation && active === operation);
export function subscribeDatabaseOperation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function beginDatabaseOperation(label: string): DatabaseOperation | null {
  if (active) return null;
  const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const operation = { id: Symbol(label), label, opener };
  active = operation;
  // Commit a focused cell before callers capture their immutable save snapshot.
  // Do not intercept blur/change: only new UI actions are blocked by the overlay.
  try { opener?.blur(); }
  catch (error) { active = null; emit(); throw error; }
  emit();
  return operation;
}
export function endDatabaseOperation(operation: DatabaseOperation): void {
  if (active !== operation) return;
  active = null;
  emit();
}
