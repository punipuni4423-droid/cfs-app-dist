'use client';

import { useEffect, useState } from 'react';
import { getPendingMigrationReport, MIGRATION_REPORT_EVENT } from '../lib/storage';
import { migrationMessage, type MigrationReport } from '../lib/migrationSafety';

export default function MigrationNotice() {
  const [report, setReport] = useState<MigrationReport>();
  useEffect(() => {
    const update = () => setReport(getPendingMigrationReport());
    update();
    window.addEventListener(MIGRATION_REPORT_EVENT, update);
    return () => window.removeEventListener(MIGRATION_REPORT_EVENT, update);
  }, []);
  if (!report) return null;
  return (
    <aside role="alert" className="card card-padded" style={{ margin: '12px', border: '1px solid #d97706' }}>
      <p>{migrationMessage(report)}</p>
      <details>
        <summary>修復・除外の詳細</summary>
        <ul>{report.issues.map((issue, index) => (
          <li key={index}>{issue.path}: {issue.action === 'excluded' ? '除外' : '修復'} {issue.count} 件</li>
        ))}</ul>
      </details>
    </aside>
  );
}
