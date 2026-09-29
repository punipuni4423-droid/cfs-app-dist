type ProjectRecord = {
  project_id: string;
  payload: Record<string, unknown>;
  version: number;
  payload_hash: string;
  payload_updated_at: string;
  row_position: number;
  total_count: number;
};

/** A valid prefix truncated by the RPC row limit, not a general read failure. */
export class ProjectRecordsTruncatedError extends Error {
  constructor() { super('Project records exceeded the RPC row limit.'); }
}

/** Reassemble the existing envelope only after verifying every returned record. */
export function assembleRecords(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Project record response was invalid.');
  const projects: Record<string, unknown>[] = [];
  const entries: [string, { version: number; hash: string; updatedAt: string }][] = [];
  const ids = new Set<string>();
  // The cast supplies types; all fields are checked below before they are used.
  const rows = ([...value] as ProjectRecord[]).sort((a, b) => a?.row_position - b?.row_position);
  const total = rows[0]?.total_count;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.project_id !== 'string' || !row.project_id.trim() || ids.has(row.project_id)
      || !Number.isSafeInteger(row.version) || row.version < 1
      || typeof row.payload_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.payload_hash)
      || !Number.isSafeInteger(row.total_count) || row.total_count < rows.length || row.total_count !== total
      || !Number.isSafeInteger(row.row_position) || row.row_position !== i + 1
      || row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)
      || row.payload.id !== row.project_id
      || typeof row.payload_updated_at !== 'string' || !row.payload_updated_at.trim()
      || row.payload_updated_at !== row.payload.updatedAt) {
      throw new Error('Project record response was incomplete or invalid.');
    }
    ids.add(row.project_id);
    projects.push(row.payload);
    entries.push([row.project_id, { version: row.version, hash: row.payload_hash, updatedAt: row.payload_updated_at }]);
  }
  if (rows.length && total > rows.length) throw new ProjectRecordsTruncatedError();
  return { projects, bases: Object.fromEntries(entries) };
}

/** Validate the complete old-format snapshot; never combine it with partial records. */
export function validateProjectEnvelope(value: Record<string, unknown>) {
  const projects = value.projects;
  const bases = value.bases;
  if (!Array.isArray(projects) || !bases || typeof bases !== 'object' || Array.isArray(bases)
    || Object.keys(bases).length !== projects.length) {
    throw new Error('Project read response was incomplete.');
  }
  const ids = new Set<string>();
  for (const project of projects) {
    const id = project?.id;
    if (!project || typeof project !== 'object' || Array.isArray(project)
      || typeof id !== 'string' || !id.trim() || ids.has(id) || !Object.hasOwn(bases, id)) {
      throw new Error('Project read response was incomplete.');
    }
    const base = (bases as Record<string, Record<string, unknown>>)[id];
    if (!base || typeof base !== 'object' || Array.isArray(base)
      || !Number.isSafeInteger(base.version) || (base.version as number) < 1
      || typeof base.hash !== 'string' || !/^[a-f0-9]{64}$/.test(base.hash)
      || typeof base.updatedAt !== 'string' || !base.updatedAt.trim() || base.updatedAt !== project.updatedAt) {
      throw new Error('Project read response was incomplete.');
    }
    ids.add(id);
  }
  return value;
}
