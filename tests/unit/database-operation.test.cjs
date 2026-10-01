const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function select(relative, names) {
  const file = path.resolve(__dirname, '../../app/lib', relative);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => node.name && names.includes(node.name.text));
  assert.equal(selected.length, names.length);
  return selected.map(node => node.getText(source)).join('\n');
}

function transportRuntime(extra = '', globals = {}) {
  const source = 'const SAVE_TIMEOUT_MS = 30000; let trashServerUpdatedAt = "baseline";\n'
    + select('projectSaveProtocol.ts', ['SaveProtocolError', 'finiteFetch']) + '\n' + extra;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports: {}, window: {}, Response, AbortController, clearTimeout,
    setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 80)), console: { error() {} }, ...globals });
  vm.runInContext(output, context);
  return context.exports;
}

function runtime() {
  class Element { blur() {} }
  const document = { activeElement: null };
  const context = vm.createContext({ HTMLElement: Element, document, console, Date, Symbol, Set, Map });
  const cache = new Map();
  const load = file => {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluate = vm.runInContext(`(function(exports, require) { ${code}\n})`, context);
    evaluate(exports, name => load(path.resolve(path.dirname(file), name + '.ts')));
    return exports;
  };
  return { api: load(path.resolve(__dirname, '../../app/lib/databaseOperation.ts')), load, document, Element };
}

test('one foreground mutation starts synchronously; only its owner can finish it', () => {
  const { api } = runtime();
  const save = api.beginDatabaseOperation('save');
  assert.ok(save);
  assert.equal(api.beginDatabaseOperation('delete'), null);
  api.endDatabaseOperation({ id: save.id });
  assert.equal(api.databaseOperationSnapshot(), save);
  api.endDatabaseOperation(save);
  const next = api.beginDatabaseOperation('restore');
  api.endDatabaseOperation(save);
  assert.equal(api.databaseOperationSnapshot(), next);
  api.endDatabaseOperation(next);
  assert.equal(api.isDatabaseOperationBusy(), false);
});

test('focused cell commits before the save snapshot; blur cannot reenter another operation', () => {
  const { api, document, Element } = runtime();
  let project = { cell: 'old' }, reentry;
  document.activeElement = new Element();
  document.activeElement.blur = () => {
    reentry = api.beginDatabaseOperation('second click');
    project = { cell: 'last typed value' };
  };
  const save = api.beginDatabaseOperation('save');
  const sent = { ...project };
  assert.equal(reentry, null);
  assert.equal(sent.cell, 'last typed value');
  assert.equal(save.opener, document.activeElement);
  api.endDatabaseOperation(save);
});

test('nested restore uses the same owned token; failure still releases only that token', async () => {
  const { api } = runtime();
  const restore = api.beginDatabaseOperation('restore');
  let posts = 0;
  try {
    await Promise.resolve();
    assert.equal(api.ownsDatabaseOperation(restore), true);
    posts++;
    throw new Error('readback unknown');
  } catch (error) { assert.equal(error.message, 'readback unknown'); }
  finally { api.endDatabaseOperation(restore); }
  assert.equal(posts, 1);
  assert.equal(api.databaseOperationSnapshot(), null);
});

test('queued observer can acquire after settlement without being cleared by an old completion', () => {
  const { api } = runtime();
  const first = api.beginDatabaseOperation('save');
  let queued;
  const unsubscribe = api.subscribeDatabaseOperation(() => {
    if (!api.isDatabaseOperationBusy()) queued = api.beginDatabaseOperation('trash');
  });
  api.endDatabaseOperation(first);
  assert.ok(queued);
  unsubscribe();
  api.endDatabaseOperation(first);
  assert.equal(api.databaseOperationSnapshot(), queued);
  api.endDatabaseOperation(queued);
});

test('failed blur does not strand the UI lock', () => {
  const { api, document, Element } = runtime();
  document.activeElement = new Element();
  document.activeElement.blur = () => { throw new Error('cell fixture'); };
  assert.throws(() => api.beginDatabaseOperation('save'), /cell fixture/);
  assert.equal(api.isDatabaseOperationBusy(), false);
});

test('queued data edits rebase independently of UI inhibition and retain revision snapshots', () => {
  const { load } = runtime();
  const { rebaseProjectSave, hasProjectChanges } = load(path.resolve(__dirname, '../../app/lib/projectSaveState.ts'));
  const before = { id: 'project', name: 'P', updatedAt: '2026-01-01T00:00:00Z', roomTypes: [{ id: 'room', name: 'R', revisions: [] }], remarks: [{ id: 'note', body: 'before' }] };
  const snapshot = '{"original":"immutable"}';
  const saved = { ...before, updatedAt: '2030-01-01T00:00:00Z', roomTypes: [{ ...before.roomTypes[0], revision: '1.01', revisions: [{ id: 'revision', snapshot }] }] };
  const later = { ...before, remarks: [{ id: 'note', body: 'queued' }], roomTypes: [...before.roomTypes, { id: 'later-room', name: 'Later' }] };
  const actual = rebaseProjectSave({ before, saved }, later);
  assert.equal(actual.remarks[0].body, 'queued');
  assert.equal(actual.roomTypes[0].revisions[0].snapshot, snapshot);
  assert.equal(actual.roomTypes[0].revision, '1.01');
  assert.equal(actual.roomTypes[1].id, 'later-room');
  assert.equal(hasProjectChanges(actual, saved), true);
  assert.ok(Date.parse(actual.updatedAt) > Date.parse(saved.updatedAt));
});

for (const stall of ['headers', 'body']) test(`actual Trash POST has a body-inclusive deadline (${stall} stall), preserves local data and never retries`, async () => {
  const source = 'const SAVE_TIMEOUT_MS = 30000; let trashServerUpdatedAt = "baseline";\n'
    + select('projectSaveProtocol.ts', ['SaveProtocolError', 'finiteFetch']) + '\n'
    + select('storage.ts', ['saveTrashToDatabase']);
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let posts = 0, local;
  const context = vm.createContext({ exports: {}, window: {}, Response, AbortController, clearTimeout,
    // Accelerate the real transport deadline, never a separate UI release timer.
    setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 80)),
    console: { error() {} }, collaborationSaveHeaders: () => ({}),
    saveLocalTrash: trash => { local = structuredClone(trash); },
    fetch: async (url, init) => {
      posts++;
      assert.equal(url, '/api/trash'); assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).expectedUpdatedAt, 'baseline');
      assert.ok(init.signal);
      if (stall === 'headers') return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    },
  });
  vm.runInContext(output, context);
  const original = { projects: [{ id: 'kept', project: { id: 'original' } }], roomTypes: [] };
  const started = Date.now();
  await assert.rejects(context.exports.saveTrashToDatabase(original, { notifyOnError: false }), error => error.code === 'SAVE_RESULT_UNKNOWN' && error.unknown === true);
  assert.ok(Date.now() - started < 2000);
  assert.equal(posts, 1);
  assert.deepEqual(local, original);
});

for (const [name, url] of [['loadProjectsFromDatabase', '/api/projects'], ['loadTrashFromDatabase', '/api/trash']]) {
  for (const stall of ['headers', 'body']) test(`${name}: ${stall} deadline rejects without retry or cache mutation`, async () => {
    let requests = 0;
    const api = transportRuntime(select('storage.ts', [name]), {
      fetch: async (actual, init) => {
        requests++; assert.equal(actual, url); assert.equal(init.cache, 'no-store');
        if (stall === 'headers') return new Promise(() => {});
        return new Response(new ReadableStream({ start() {} }));
      },
      saveLocalTrash: () => assert.fail('must not overwrite retained Trash'),
      saveLocalProjects: () => assert.fail('must not overwrite retained projects'),
    });
    await assert.rejects(api[name]({ throwOnError: true }), error => error.code === 'SAVE_RESULT_UNKNOWN' && error.unknown);
    assert.equal(requests, 1);
  });
}

for (const when of ['before', 'headers', 'body']) test(`finiteFetch propagates external abort (${when}) and removes its listener`, async () => {
  const controller = new AbortController();
  let requests = 0, forwarded, added = 0, removed = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; }, get reason() { return controller.signal.reason; },
    addEventListener(...args) { added++; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removed++; controller.signal.removeEventListener(...args); },
  };
  const api = transportRuntime('', {
    fetch: async (_url, init) => {
      requests++; forwarded = init.signal;
      if (when === 'headers') return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }));
    },
  });
  if (when === 'before') controller.abort('owner changed');
  const pending = api.finiteFetch('/api/projects', { signal });
  const rejection = assert.rejects(pending, error => error.code === 'SAVE_RESULT_UNKNOWN' && error.unknown);
  await Promise.resolve();
  controller.abort('owner changed');
  await rejection;
  assert.equal(requests, when === 'before' ? 0 : 1);
  if (forwarded) { assert.equal(forwarded.aborted, true); assert.equal(forwarded.reason, 'owner changed'); }
  assert.equal(added, when === 'before' ? 0 : 1);
  assert.equal(removed, 1);
});

test('finiteFetch returns a complete successful body and detaches external cancellation', async () => {
  const controller = new AbortController(); let forwarded;
  const api = transportRuntime('', { fetch: async (_url, init) => { forwarded = init.signal; return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); } });
  const response = await api.finiteFetch('/api/projects', { signal: controller.signal });
  assert.deepEqual(await response.json(), { ok: true });
  controller.abort();
  assert.equal(forwarded.aborted, false);
});

for (const ownerChange of [false, true]) test(`actual Trash effect serializes snapshots through the last body (owner change: ${ownerChange})`, async () => {
  const { api } = runtime();
  const sourceFile = ts.createSourceFile('page.tsx', fs.readFileSync(path.resolve(__dirname, '../../app/page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'useEffect'
      && node.arguments[0]?.getText(sourceFile).includes('const scheduledCollaboration = trashSaveIdentity.current')) effect = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile); assert.ok(effect);
  let cleanup;
  const timers = new Map(), posts = [], pending = [];
  let nextTimer = 0;
  const context = vm.createContext({
    initialized: { current: true }, skipNextTrashSave: { current: false }, ownerEpoch: { current: 1 },
    trashSaveIdentity: { current: {} }, trashOperation: { current: null }, trashSaveTimer: { current: null },
    trashSavesInFlight: { current: new Set() }, trash: { version: 1 },
    beginOperation: api.beginDatabaseOperation, ownsDatabaseOperation: api.ownsDatabaseOperation,
    endDatabaseOperation: api.endDatabaseOperation, subscribeDatabaseOperation: api.subscribeDatabaseOperation,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setNotificationTrashRevision() {}, setNotificationTrashUnverified() {}, setSaveStatus() {},
    saveTrashToDatabase: trash => { posts.push(trash.version); return new Promise(resolve => pending.push(resolve)); },
    useEffect: run => { cleanup = run(); },
  });
  const code = ts.transpileModule(effect.getText(sourceFile), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const runTimer = () => { assert.equal(timers.size, 1); const [id, fn] = [...timers][0]; timers.delete(id); fn(); };
  vm.runInContext(code, context); runTimer();
  assert.deepEqual(posts, [1]); assert.equal(api.isDatabaseOperationBusy(), true);
  const firstToken = api.databaseOperationSnapshot();
  cleanup();
  if (ownerChange) {
    context.ownerEpoch.current++;
    api.endDatabaseOperation(firstToken);
    context.trashOperation.current = null;
  }
  context.trash = { version: 2 }; vm.runInContext(code, context);
  assert.equal(timers.size, 0); assert.deepEqual(posts, [1]);
  assert.equal(api.databaseOperationSnapshot(), ownerChange ? null : firstToken);
  pending[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isDatabaseOperationBusy(), true); assert.notEqual(api.databaseOperationSnapshot(), firstToken);
  runTimer(); assert.deepEqual(posts, [1, 2]);
  api.endDatabaseOperation(firstToken); assert.equal(api.isDatabaseOperationBusy(), true);
  pending[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isDatabaseOperationBusy(), false);
  cleanup();
});

test('late Trash response from the old owner cannot replace the current CAS token or alert the new owner', async () => {
  let current = true, release, requests = 0, localWrites = 0;
  const api = transportRuntime(select('storage.ts', ['saveTrashToDatabase']), {
    window: { alert: () => assert.fail('stale owner alert') },
    collaborationSaveHeaders: () => ({}), saveLocalTrash: () => { localWrites++; },
    fetch: async (_url, init) => {
      requests++;
      assert.equal(JSON.parse(init.body).expectedUpdatedAt, 'baseline');
      if (requests === 1) await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ updatedAt: 'stale-owner-result' }));
    },
  });
  const pending = api.saveTrashToDatabase({ projects: [], roomTypes: [] }, { isCurrent: () => current });
  const rejection = assert.rejects(pending, /user has changed/);
  current = false; release(); await rejection;
  await assert.rejects(api.saveTrashToDatabase({}, { isCurrent: () => false }), /user has changed/);
  assert.equal(requests, 1); assert.equal(localWrites, 1);
  await api.saveTrashToDatabase({ projects: [], roomTypes: [] });
  assert.equal(requests, 2);
});
