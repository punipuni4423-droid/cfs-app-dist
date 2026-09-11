import { test, expect } from './support/safe-test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

test('unverified account B never uses account A owner with B credential or resumes editing through status poll', async ({ page }) => {
  await page.route('**/auth-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>synthetic auth harness</title>' }));
  await page.goto('/auth-harness');
  const sources = Object.fromEntries(['useCollaboration', 'apiAccessClient', 'projectSaveProtocol', 'canonicalJson', 'id'].map(name => [name,
    ts.transpileModule(fs.readFileSync(path.resolve(`app/lib/${name}.ts`), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText]));
  const result = await page.evaluate(async sources => {
    // Hook scheduler replaces only React/SDK plumbing; production hook and
    // protocol modules execute unchanged, with synthetic fetch responses.
    type Slot = { value?: any; deps?: any[]; cleanup?: () => void };
    const slots: Slot[] = [];
    let cursor = 0, queued = false, effects: Array<() => void> = [], controller: any, hook: any;
    let authEvent: any, allowB = false, acquires = 0;
    const changed = (old: any[] | undefined, next: any[] | undefined) => !old || !next || old.length !== next.length || old.some((value, i) => !Object.is(value, next[i]));
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };
    const react = {
      useState(initial: any) { const index = cursor++; const slot = slots[index] ?? (slots[index] = { value: typeof initial === 'function' ? initial() : initial }); return [slot.value, (next: any) => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; schedule(); } }]; },
      useRef(initial: any) { const index = cursor++; return (slots[index] ?? (slots[index] = { value: { current: initial } })).value; },
      useMemo(factory: () => any, deps?: any[]) { const index = cursor++; const slot = slots[index] ?? (slots[index] = {}); if (changed(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; } return slot.value; },
      useCallback(callback: any, deps: any[]) { return react.useMemo(() => callback, deps); },
      useEffect(effect: () => any, deps?: any[]) { const index = cursor++; const slot = slots[index] ?? (slots[index] = {}); if (changed(slot.deps, deps)) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); }); } },
    };
    function render() { queued = false; cursor = 0; effects = []; controller = hook('synthetic-project'); const pending = effects; pending.forEach(effect => effect()); }
    const modules: Record<string, { exports: any }> = {};
    const require = (name: string): any => {
      if (name === 'react') return react;
      if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: {
        getSession: async () => ({ data: { session: { access_token: 'token-A' } } }),
        onAuthStateChange: (callback: any) => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      } }) };
      name = name.replace('./', '');
      if (!modules[name]) { const module = { exports: {} }; modules[name] = module; new Function('require', 'exports', 'module', sources[name])(require, module.exports, module); }
      return modules[name].exports;
    };
    window.fetch = async (input, init) => {
      const url = String(input);
      const token = new Headers(init?.headers).get('Authorization');
      const id = token === 'Bearer token-B' ? 'B' : 'A';
      const membership = { id, authUserId: id, displayName: id, email: `${id}@example.test`, role: 'admin', active: true };
      if (url.includes('/sharing/config')) return Response.json({ mode: 'supabase', url: 'https://synthetic.invalid', publishableKey: 'synthetic' });
      if (url.includes('/collaboration/auth')) return id === 'B' && !allowB ? Response.json({ error: 'synthetic unavailable' }, { status: 503 }) : Response.json({ membership });
      if (url.includes('/lock/acquire')) acquires++;
      return Response.json({ enabled: true, mode: 'edit', projectId: 'synthetic-project', membership, lock: { userId: id, sessionId: 'session', expiresAt: '2099-01-01T00:00:00Z' }, locks: [], heartbeatMs: 900000, idleMs: 900000 });
    };
    hook = require('useCollaboration').useCollaboration;
    render();
    const wait = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('synthetic hook condition timed out'); };
    await wait(() => Boolean(authEvent) && controller.user?.id === 'A');
    authEvent('TOKEN_REFRESHED', { access_token: 'token-B' });
    await wait(() => controller.authVerificationBlocked === true);
    await controller.refreshStatus();
    await controller.startEditing();
    await new Promise(resolve => setTimeout(resolve, 10));
    const blocked = { owner: controller.user.id, token: controller.accessToken, mode: controller.mode, canEdit: controller.canEdit, canCreate: controller.canCreateProject, acquires };
    allowB = true;
    authEvent('SIGNED_IN', { access_token: 'token-B' });
    await wait(() => controller.user?.id === 'B' && !controller.authVerificationBlocked);
    const verified = { owner: controller.user.id, token: controller.accessToken };
    slots.forEach(slot => slot.cleanup?.());
    return { blocked, verified };
  }, sources);
  expect(result.blocked).toEqual({ owner: 'A', token: 'token-A', mode: 'view', canEdit: false, canCreate: false, acquires: 0 });
  expect(result.verified).toEqual({ owner: 'B', token: 'token-B' });
});
