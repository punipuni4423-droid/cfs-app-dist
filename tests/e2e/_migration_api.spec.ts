import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createNewProject, migrateProjectsPayload } from '../../app/lib/storage';
import { createNewRoomType, createEmptySwitchEntry } from '../../app/lib/constants';

function fixture() {
  const project = createNewProject('API Safety');
  project.roomTypes = [createNewRoomType('Room')];
  project.roomTypes[0].switches = [createEmptySwitchEntry('contact'), createEmptySwitchEntry('command')];
  return project;
}

/** Executes the actual route with memory-only filesystem and sharing adapters. No real API/files. */
function harness(initial: unknown[], options: { baseline?: boolean; secure?: boolean } = {}) {
  let stored = JSON.stringify(initial);
  let writes = 0;
  let temp = '';
  const filename = path.resolve('app/api/projects/route.ts');
  const source = options.baseline
    ? execFileSync('git', ['show', 'HEAD:app/api/projects/route.ts'], { encoding: 'utf8' })
    : readFileSync(filename, 'utf8');
  const loaded = new Module(filename, module) as Module & { _compile(code: string, filename: string): void; paths: string[] };
  loaded.filename = filename;
  loaded.paths = module.paths;
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = ((id: string) => {
    if (id.endsWith('/apiAuth')) return { requireApiAccess: async () => null }; // Auth has its own route matrix; keep migration tests isolated.
    if (id.endsWith('/localProjectStore')) return { localProjectStore: {
      locked: async (operation: () => Promise<unknown>) => operation(),
      readProjects: async () => JSON.parse(stored),
      writeProjects: async (value: unknown) => { stored = JSON.stringify(value); writes++; },
    } };
    if (id === 'node:fs/promises') return {
      readFile: async () => stored,
      mkdir: async () => {}, rm: async () => {}, stat: async () => ({ mtimeMs: Date.now() }),
      writeFile: async (_name: string, value: string) => { temp = value; },
      rename: async () => { stored = temp; writes++; },
    };
    if (id.endsWith('/requestGuard')) return { isAllowedReadRequest: () => true, isAllowedWriteRequest: () => true };
    if (id.endsWith('/collaborationServer')) return {
      requireCollaborationEditLock: async () => ({ ok: true, editor: null }),
      requireCollaborationProjectCreate: async () => ({ ok: true, editor: null }),
      recordCollaborationSave: async () => null,
    };
    if (id.endsWith('/secureSharingServer')) {
      const call = async (_request: Request, action: string, payload: Record<string, unknown> = {}) => {
        if (action === 'projects.read') return { status: 200, body: { projects: JSON.parse(stored) } };
        writes++;
        return { status: 200, body: { ok: true, ...payload } };
      };
      return {
        isSecureSharingEnabled: () => options.secure === true,
        secureSharingSessionPayload: () => ({}),
        callSecureSharingFunctionJson: call,
        callSecureSharingFunction: async (...args: Parameters<typeof call>) => {
          const result = await call(...args);
          return Response.json(result.body, { status: result.status });
        },
      };
    }
    return nativeRequire(id);
  }) as NodeRequire;
  loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
  return {
    post: (body: unknown) => loaded.exports.POST(new Request('http://127.0.0.1:3087/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })) as Promise<Response>,
    get: () => loaded.exports.GET(new Request('http://127.0.0.1:3087/api/projects')) as Promise<Response>,
    writes: () => writes,
    stored: () => JSON.parse(stored),
    replace: (value: unknown[]) => { stored = JSON.stringify(value); },
  };
}

test('detection power: pre-fix API silently accepts collection shrinkage', async () => {
  const project = fixture();
  const api = harness([project], { baseline: true });
  const reduced = structuredClone(project);
  reduced.roomTypes[0].switches.pop();
  expect((await api.post({ project: reduced, expectedUpdatedAt: project.updatedAt })).status).toBe(200);
  expect(api.writes()).toBe(1); // The new safety expectation (409 / zero writes) fails before the fix.
});

for (const secure of [false, true]) {
  for (const bulk of [false, true]) {
    test(`API rejects and requires snapshot-bound confirmation (${secure ? 'shared' : 'local'}, ${bulk ? 'bulk' : 'single'})`, async () => {
      const project = fixture();
      const api = harness([project], { secure });
      const reduced = structuredClone(project);
      reduced.roomTypes[0].switches.pop();
      const body = bulk ? { projects: [reduced], expectedUpdatedAts: { [project.id]: project.updatedAt } } : { project: reduced, expectedUpdatedAt: project.updatedAt };
      const first = await api.post(body);
      expect(first.status).toBe(409);
      expect(api.writes()).toBe(0);
      const rejection = await first.json();
      expect(rejection.code).toBe('MIGRATION_CONFIRMATION_REQUIRED');
      expect(rejection.migrationReport.excluded).toBe(1);
      const changed = structuredClone(project);
      changed.name = 'Concurrent change';
      api.replace([changed]);
      expect((await api.post({ ...body, migrationConfirmation: rejection.migrationConfirmation })).status).toBe(409);
      expect(api.writes()).toBe(0);
      api.replace([project]);
      expect((await api.post({ ...body, migrationConfirmation: rejection.migrationConfirmation })).status).toBe(200);
      expect(api.writes()).toBe(1);
    });
  }
}

test('GET reports a broken stored element; saving another project preserves the original raw record', async () => {
  const broken = fixture();
  (broken.roomTypes[0].switches as unknown[]).push(null);
  const good = fixture();
  const api = harness([broken, good]);
  const read = await (await api.get()).json();
  expect(read.migrationReport.excluded).toBe(1);
  expect(read.projects[0].roomTypes[0].switches).toHaveLength(2);
  expect(api.writes()).toBe(0);
  expect((await api.post({ project: good, expectedUpdatedAt: good.updatedAt })).status).toBe(200);
  expect(api.stored()[0]).toEqual(broken);
  const cleaned = migrateProjectsPayload([broken])[0];
  expect((await api.post({ project: cleaned, expectedUpdatedAt: broken.updatedAt })).status).toBe(409);
});

test('POST never silently removes malformed incoming elements', async () => {
  const project = fixture();
  const api = harness([project]);
  (project.roomTypes[0].switches as unknown[]).push(null);
  const response = await api.post({ project, expectedUpdatedAt: project.updatedAt });
  expect(response.status).toBe(409);
  expect(api.writes()).toBe(0);
});

test('API detects requested empty scenes before legacy default generation can mask shrinkage', async () => {
  const project = fixture();
  const api = harness([project]);
  const empty = structuredClone(project);
  empty.roomTypes[0].roomScenes = [];
  expect((await api.post({ project: empty, expectedUpdatedAt: project.updatedAt })).status).toBe(409);
  expect(api.writes()).toBe(0);
});
