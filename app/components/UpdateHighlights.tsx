"use client";

import { useEffect, useState } from 'react';
import changelog from '../data/user-changelog.json';
import { loadUnreadChangelog, saveChangelogSeen, type UserChangelogSelection } from '../lib/userChangelog';

export default function UpdateHighlights() {
  const [selection, setSelection] = useState<UserChangelogSelection | null>(null);

  useEffect(() => {
    setSelection(loadUnreadChangelog(changelog.entries, () => window.localStorage));
  }, []);

  if (!selection?.visible.length) return null;

  function close() {
    if (selection?.latestId) {
      try { saveChangelogSeen(window.localStorage, selection.latestId); } catch { /* Storage getter can throw. */ }
    }
    setSelection(null);
  }

  return (
    <section className="update-highlights" aria-labelledby="update-highlights-title" data-testid="update-highlights">
      <div className="update-highlights-heading">
        <h2 id="update-highlights-title">What&apos;s new</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={close} aria-label="Close what's new">Close</button>
      </div>
      {selection.visible.map(entry => (
        <article className="update-highlights-entry" key={entry.id}>
          <h3><time dateTime={entry.date}>{entry.date}</time><span>{entry.title.split(' ／ ').map((line, index) => <span key={index} lang={index ? 'ja' : 'en'} style={{ display: 'block' }}>{line}</span>)}</span></h3>
          <ul>{entry.items.map((item, index) => <li key={index}>{item.split(' ／ ').map((line, part) => <span key={part} lang={part ? 'ja' : 'en'} style={{ display: 'block' }}>{line}</span>)}</li>)}</ul>
        </article>
      ))}
      {selection.remaining > 0 && <p className="update-highlights-more">{selection.remaining} more earlier update{selection.remaining === 1 ? '' : 's'} not shown.</p>}
      <p className="update-highlights-note">Close to mark all these updates as read.</p>
    </section>
  );
}
