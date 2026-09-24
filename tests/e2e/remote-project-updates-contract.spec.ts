import { test, expect } from '@playwright/test';
import { parseProjectUpdates, mergeProjectUpdates, unreadProjectUpdates } from '../../app/lib/remoteProjectUpdates';
import { readProjectUpdates } from '../../supabase/functions/cfs-api/projectUpdates';
const time = '2026-09-17T10:00:00.000Z';
const row = (id: string, stamp = time) => ({ id, updatedAt: stamp, lastUpdatedBy: { userId: 'other', displayName: 'Same name', updatedAt: stamp } });

test('T38 parser rejects unknown, malformed, duplicate and impossible dates with identity fallback', () => {
  expect(parseProjectUpdates(undefined)).toBeNull(); expect(parseProjectUpdates([row('a'), row('a')])).toBeNull();
  for (const stamp of ['bad', '2026-02-30T00:00:00.000Z', '2026-09-17', '2026-09-17T10:00:00Z']) expect(parseProjectUpdates([row('a', stamp)])).toEqual([]);
  expect(parseProjectUpdates([{ ...row('a'), lastUpdatedBy: { userId: '', displayName: 'Unknown', updatedAt: time } }])).toEqual([]);
  expect(parseProjectUpdates([{ ...row('a'), lastUpdatedBy: { userId: 'other', updatedAt: time } }])?.[0].lastUpdatedBy?.displayName).toBe('Another user');
  expect(parseProjectUpdates([row('a')])?.[0]).toEqual(row('a'));
});
test('T38 monotonic events survive missing and delayed old values; mutable baseline clears immediately', () => {
  const newer = row('a', '2026-09-17T11:00:00.000Z');
  let known = mergeProjectUpdates(new Map(), [newer]); known = mergeProjectUpdates(known, [row('a')]); known = mergeProjectUpdates(known, []);
  const baseline = new Map([['a', time]]);
  expect(unreadProjectUpdates(known, baseline, 'self').size).toBe(1); expect(unreadProjectUpdates(known, baseline, 'other').size).toBe(0);
  baseline.set('a', newer.updatedAt); expect(unreadProjectUpdates(known, baseline, 'self').size).toBe(0);
});
test('T38 summary reads >1000 rows, server short-page cap, empty exhaustion and whitelists author', async () => {
  const source = Array.from({ length: 1203 }, (_, n) => ({ ...row(String(n).padStart(5, '0')), lastUpdatedBy: { ...row('x').lastUpdatedBy, email: 'not-for-response@example.test' } }));
  let calls = 0;
  const result = await readProjectUpdates(async after => { calls++; return { data: source.filter(item => !after || item.id > after).slice(0, 77), error: null }; });
  expect(result).toHaveLength(1203); expect(calls).toBe(17); expect(JSON.stringify(result)).not.toContain('email');
});
test('T38 summary overflow, duplicate order and read failure return unknown', async () => {
  const source = Array.from({ length: 2001 }, (_, n) => row(String(n).padStart(5, '0')));
  expect(await readProjectUpdates(async (after, size) => ({ data: source.filter(item => !after || item.id > after).slice(0, size), error: null }))).toBeUndefined();
  expect(await readProjectUpdates(async () => ({ data: [row('b'), row('a')], error: null }))).toBeUndefined();
  expect(await readProjectUpdates(async () => ({ data: [], error: new Error('synthetic') }))).toBeUndefined();
});
test('T38 real 1500ms deadline returns unknown even when reader ignores abort', async () => {
  let calls = 0, stopped = false;
  const started = Date.now();
  const result = await readProjectUpdates(async (_after, _size, signal) => { calls++; signal.addEventListener('abort', () => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 1700)); return { data: Array.from({ length: 200 }, (_, n) => row(String(n).padStart(5, '0'))), error: null }; });
  expect(result).toBeUndefined(); expect(Date.now() - started).toBeLessThan(1650); expect(stopped).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 250)); expect(calls).toBe(1);
});
