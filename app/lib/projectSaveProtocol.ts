import type { ProjectData } from '../types';
import { canonicalJson } from './canonicalJson';
import { createAppId } from './id';

export const SAVE_PROTOCOL_VERSION = 2;
export const SAVE_TIMEOUT_MS = 30_000;
export class SaveProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly unknown = false) {
    super(message); this.name = 'SaveProtocolError';
  }
}
export function saveContent(project: ProjectData): unknown {
  return { ...project, updatedAt: undefined, lastUpdatedBy: undefined, lastSaveOperation: undefined,
    roomTypes: project.roomTypes.map(room => ({ ...room, updatedAt: undefined })) };
}
export async function projectFingerprint(project: ProjectData): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(saveContent(project)));
  if (!globalThis.crypto?.subtle) {
    // Equality is also checked against the complete canonical body below.
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return `content-${bytes.length}-${(hash >>> 0).toString(16)}`;
  }
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function prepareSaveProject(project: ProjectData, kind: 'current' | 'revision' | 'idle', operationId = createAppId()): Promise<ProjectData> {
  const snapshot = structuredClone(project);
  return { ...snapshot, lastSaveOperation: { id: operationId, kind, fingerprint: await projectFingerprint(snapshot) } };
}
export async function matchesSaveIntent(sent: ProjectData, received: ProjectData): Promise<boolean> {
  return Boolean(received && Array.isArray(received.roomTypes)) && received.id === sent.id && Boolean(sent.lastSaveOperation)
    && received.lastSaveOperation?.id === sent.lastSaveOperation?.id
    && received.lastSaveOperation?.kind === sent.lastSaveOperation?.kind
    && received.lastSaveOperation?.fingerprint === sent.lastSaveOperation?.fingerprint
    && canonicalJson(saveContent(received)) === canonicalJson(saveContent(sent));
}
export async function finiteFetch(url: string, init: RequestInit, timeout = SAVE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeout);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      // The deadline includes body consumption; headers alone are not completion.
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    })()]);
  }
  catch { throw new SaveProtocolError('SAVE_RESULT_UNKNOWN', '保存結果を確認できません。保存状態を確認してください。', undefined, true); }
  finally { clearTimeout(timer); }
}
export function saveError(status: number, code?: string): SaveProtocolError {
  const messages: Record<number, string> = {
    401: 'サインインの有効期限が切れました。下書きを保持して再サインインしてください。',
    403: '保存権限を確認してください。下書きは保持しています。',
    409: code === 'SAVE_PROTOCOL_REQUIRED' || code === 'COMMON_HISTORY_PROTECTED' ? '保存形式が古いか、共通履歴が欠落しています。アプリを更新して確認してください。' : '共有データが更新されています。最新データと下書きを確認してください。',
    413: '保存データが容量上限を超えています。バックアップして管理者へ確認してください。',
    423: '編集権限を失いました。下書きを保持して編集権限を再取得してください。',
  };
  return new SaveProtocolError(code ?? `SAVE_HTTP_${status}`, messages[status] ?? '保存を確認できません。接続と保存状態を確認してください。', status, status >= 500);
}
export function commonHistoryPreserved(before: ProjectData | undefined, incoming: ProjectData): boolean {
  if ((before?.commonRevisions !== undefined && !Array.isArray(before.commonRevisions)) || (incoming.commonRevisions !== undefined && !Array.isArray(incoming.commonRevisions))) return false;
  return (before?.commonRevisions ?? []).every(old => (incoming.commonRevisions ?? []).some(item => item.id === old.id && canonicalJson(item) === canonicalJson(old)));
}
