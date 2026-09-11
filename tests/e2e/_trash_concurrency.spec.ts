import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createNewProject } from '../../app/lib/storage';
import { execFileSync } from 'node:child_process';

test('concurrent trash saves reject a stale snapshot instead of overwriting the first save', async () => {
  let stored = JSON.stringify({ projects: [], roomTypes: [] });
  const temps = new Map<string, string>();
  const locks = new Set<string>();
  let storeQueue = Promise.resolve<unknown>(undefined);
  const filename = path.resolve('app/api/trash/route.ts');
  const loaded = new Module(filename, module) as Module & { _compile(code: string, filename: string): void; paths: string[] };
  loaded.filename = filename; loaded.paths = module.paths;
  const native = loaded.require.bind(loaded);
  loaded.require = ((id: string) => {
    if (id.endsWith('/apiAuth')) return { requireApiAccess: async () => null };
    if (id.endsWith('/collaborationServer')) return { requireCollaborationEditLock: async () => ({ ok: true }) };
    if (id.endsWith('/secureSharingServer')) return { isSecureSharingEnabled: () => false };
    if (id.endsWith('/localProjectStore')) return { localProjectStore: {
      locked: (operation: () => Promise<unknown>) => {
        const result = storeQueue.then(operation);
        storeQueue = result.catch(() => undefined);
        return result;
      },
      readTrash: async () => JSON.parse(stored),
      writeTrash: async (value: unknown) => { stored = JSON.stringify(value); },
    } };
    if (id === 'node:fs/promises') return {
      readFile: async () => stored,
      mkdir: async (name: string, options?: unknown) => {
        if (options) return;
        if (locks.has(name)) throw Object.assign(new Error('busy'), { code: 'EEXIST' });
        locks.add(name);
      },
      rm: async (name: string) => { locks.delete(name); },
      writeFile: async (name: string, value: string) => { temps.set(name, value); },
      rename: async (name: string) => { stored = temps.get(name)!; },
    };
    return native(id);
  }) as NodeRequire;
  const source = process.env.CFS_TRASH_BASELINE === '1' ? execFileSync('git', ['show', 'HEAD:app/api/trash/route.ts'], { encoding: 'utf8' }) : readFileSync(filename, 'utf8');
  loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
  const request = () => new Request('http://127.0.0.1:3087/api/trash');
  const snapshot = await (await loaded.exports.GET(request())).json();
  const save = (name: string) => loaded.exports.POST(new Request(request(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trash: { projects: [{ id: name, deletedAt: new Date().toISOString(), project: createNewProject(name) }], roomTypes: [] }, expectedUpdatedAt: snapshot.updatedAt }) })) as Promise<Response>;
  const responses = await Promise.all([save('First'), save('Second')]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const success = await responses.find(r => r.status === 200)!.json();
  expect(success.updatedAt).toBeTruthy();
  expect((await (await loaded.exports.GET(request())).json()).updatedAt).toBe(success.updatedAt);
  expect(JSON.parse(stored).projects).toEqual(success.trash.projects);
});
