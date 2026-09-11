/** Data-loss diagnostics shared by the browser and the projects API. No raw values in logs. */
export interface MigrationIssue {
  path: string;
  action: 'excluded' | 'repaired';
  count: number;
}

export interface MigrationReport {
  issues: MigrationIssue[];
  excluded: number;
  repaired: number;
}

// Browser-only review state, never persisted in ProjectData or shared between server requests.
let migrationReviewPending = false;
export function setMigrationReviewPending(pending: boolean): void {
  if (typeof window !== 'undefined') migrationReviewPending = pending;
}
export function isMigrationReviewPending(): boolean {
  return typeof window !== 'undefined' && migrationReviewPending;
}

export function migrationReport(issues: MigrationIssue[]): MigrationReport {
  const unique = new Map<string, MigrationIssue>();
  for (const issue of issues) {
    const key = `${issue.path}:${issue.action}`;
    const previous = unique.get(key);
    unique.set(key, { ...issue, count: Math.max(previous?.count ?? 0, issue.count) });
  }
  issues = [...unique.values()];
  return {
    issues,
    excluded: issues.filter((issue) => issue.action === 'excluded').reduce((n, issue) => n + issue.count, 0),
    repaired: issues.filter((issue) => issue.action === 'repaired').reduce((n, issue) => n + issue.count, 0),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Match object collections by stable ID, so sorting cannot hide losses in another room. */
export function collectionLosses(before: unknown, after: unknown, path = 'projects'): MigrationIssue[] {
  // This is a normalized enum-like configuration vector, not a record collection.
  // Legacy duplicate Backlight levels are intentionally collapsed by existing migration.
  if (path.endsWith('.backlightLevels')) return [];
  if (Array.isArray(before)) {
    const next: unknown[] = Array.isArray(after) ? after : [];
    const issues: MigrationIssue[] = before.length > next.length
      ? [{ path, action: 'excluded', count: before.length - next.length }] : [];
    before.forEach((item, index) => {
      const itemRecord = record(item);
      if (!itemRecord) return;
      const match = typeof itemRecord.id === 'string'
        ? next.find((candidate) => record(candidate)?.id === itemRecord.id)
        : next[index];
      // A removed parent is counted once, not once per nested child as well.
      if (match !== undefined) issues.push(...collectionLosses(item, match, `${path}[${index}]`));
    });
    return issues;
  }
  const previous = record(before);
  const next = record(after);
  if (!previous || !next) return [];
  return Object.keys(previous).flatMap((key): MigrationIssue[] => {
    if (!Array.isArray(previous[key]) && Array.isArray(next[key]) && previous[key] !== undefined) {
      return [{ path: `${path}.${key}`, action: 'repaired', count: 1 }];
    }
    return collectionLosses(previous[key], next[key], `${path}.${key}`);
  });
}

export function migrationMessage(report: MigrationReport): string {
  return `読込時に ${report.repaired + report.excluded} 件を修復/除外しました（修復 ${report.repaired} 件、除外 ${report.excluded} 件）。自動保存を停止しています。内容を確認してから保存してください。`;
}
