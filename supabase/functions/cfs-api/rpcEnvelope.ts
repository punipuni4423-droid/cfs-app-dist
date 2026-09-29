/** Require the single envelope emitted by the row-returning RPCs. */
export function unwrapRpcEnvelope(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('RPC response cardinality was invalid.');
  }
  const row: unknown = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('RPC response was invalid.');
  }
  return row as Record<string, unknown>;
}
