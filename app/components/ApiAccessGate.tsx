'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { setApiIdentity } from '../lib/apiAccessClient';

let authentication: Promise<void> | undefined;

export default function ApiAccessGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続を確認しています…');
  useEffect(() => {
    let active = true;
    authentication ??= (async () => {
        const fragment = new URLSearchParams(location.hash.slice(1));
        const grant = fragment.get('cfs_access');
        if (grant) {
          fragment.delete('cfs_access');
          history.replaceState(null, '', location.pathname + location.search + (fragment.size ? `#${fragment}` : ''));
          const exchange = await fetch('/auth/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant }) });
          if (!exchange.ok) throw new Error('接続リンクが無効または期限切れです。');
        }
        const response = await fetch('/auth/connect', { cache: 'no-store' });
        if (!response.ok) throw new Error('CFSへの接続認証が必要です。');
        setApiIdentity(await response.json());
    })();
    void authentication.then(() => { if (active) setReady(true); }).catch(error => { if (active) setMessage(error instanceof Error ? error.message : '接続できませんでした。'); });
    return () => { active = false; };
  }, []);
  if (ready) return children;
  return <main className="m-auto max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-slate-800 shadow-sm"><h1 className="mb-4 text-xl font-semibold">CFS に接続</h1><p role="status">{message}</p><p className="mt-4 text-sm text-slate-600">PCでは CFS のランチャーから起動し直してください。タブレットでは、PCで発行した接続リンク・QRコードを開いてください。</p><button className="mt-5 rounded-lg bg-cyan-700 px-4 py-2 text-white" onClick={() => location.reload()}>再確認</button></main>;
}
