// Independent, bounded metadata observation. Missing rows never mean deletion.
export const PROJECT_UPDATE_PAGE_SIZE = 200;
export const PROJECT_UPDATE_LIMIT = 2000;
export const PROJECT_UPDATE_DEADLINE_MS = 1500;

type Row = { id: string; updatedAt: string; lastUpdatedBy: unknown };
type PageReader = (after: string | null, size: number, signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;

export async function readProjectUpdates(read: PageReader, deadlineMs = PROJECT_UPDATE_DEADLINE_MS) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scan = async () => {
    const rows: Row[] = [];
    let cursor: string | null = null;
    while (!controller.signal.aborted) {
      const result = await read(cursor, Math.min(PROJECT_UPDATE_PAGE_SIZE, PROJECT_UPDATE_LIMIT + 1 - rows.length), controller.signal);
      if (controller.signal.aborted || result.error || !Array.isArray(result.data)) return undefined;
      const page = result.data;
      for (const raw of page) {
        if (!raw || typeof raw !== 'object') return undefined;
        const row = raw as Record<string, unknown>;
        if (typeof row.id !== 'string' || !row.id || row.id.length > 200 || (cursor !== null && row.id <= cursor)) return undefined;
        cursor = row.id;
        const author = row.lastUpdatedBy && typeof row.lastUpdatedBy === 'object' ? row.lastUpdatedBy as Record<string, unknown> : null;
        // Whitelist fields: payload metadata can contain older extension properties.
        rows.push({ id: row.id, updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '', lastUpdatedBy: author ? {
          userId: typeof author.userId === 'string' ? author.userId : '',
          displayName: typeof author.displayName === 'string' ? author.displayName.slice(0, 120) : '',
          updatedAt: typeof author.updatedAt === 'string' ? author.updatedAt : '',
        } : null });
        if (rows.length > PROJECT_UPDATE_LIMIT) return undefined;
      }
      // The API may cap a requested page below our requested size.
      // Only an empty page proves the keyset has been exhausted.
      if (page.length === 0) return rows;
    }
    return undefined;
  };
  try {
    // Race also bounds readers which do not honour AbortSignal.
    return await Promise.race([scan().catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(undefined); }, deadlineMs);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
