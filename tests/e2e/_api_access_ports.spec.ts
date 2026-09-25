import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createGrant, type AuthKeys } from '../../app/lib/apiAuthCore.mjs';
import { createNewProject } from '../../app/lib/storage';
import { SAVE_PROTOCOL_VERSION } from '../../app/lib/projectSaveProtocol';

// The harness starts two isolated instances and owns their process/data cleanup.
// Never run this against existing installations or with page/API auth mocks.
function endpoints(baseURL: string) {
  const peer = process.env.CFS_PORTS_PEER_URL;
  const auth = process.env.CFS_AUTH_DIR;
  const peerAuth = process.env.CFS_PORTS_PEER_AUTH_DIR;
  if (!peer || !auth || !peerAuth) throw new Error('Two isolated servers and separate auth roots are required');
  const urls = [new URL(baseURL), new URL(peer)];
  if (urls.some(url => url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) < 3086 || Number(url.port) > 3095 || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    || urls[0].hostname !== urls[1].hostname || urls[0].port === urls[1].port || path.resolve(auth) === path.resolve(peerAuth)) throw new Error('Unsafe multiport fixture');
  return urls.map((url, i) => ({ origin: url.origin, authDir: i ? peerAuth : auth }));
}

async function connect(page: Page, origin: string, keys: AuthKeys) {
  await page.goto(`${origin}/#cfs_access=${createGrant(keys)}`);
  // The first authenticated render can compile routes on both isolated dev servers.
  // Bound this cold-start wait without pre-authenticating or changing cookie state.
  await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible({ timeout: 30000 });
}

async function assertConnected(context: BrowserContext, page: Page, origin: string) {
  expect((await context.request.get(`${origin}/auth/connect`)).status()).toBe(200);
  expect((await context.request.get(`${origin}/api/app-update/status?fetchRemote=0`)).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'CFS Project Selection' })).toBeVisible();
}

for (const reverse of [false, true]) {
  test(`two real servers retain cookie authentication and saved data (${reverse ? 'B-A-B' : 'A-B-A'})`, async ({ browser, baseURL }) => {
    test.setTimeout(240000);
    const servers = endpoints(baseURL!);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      // This initializes only the two synthetic auth files, without credentials.
      for (const server of servers) await context.request.get(`${server.origin}/auth/connect`);
      const keys = servers.map(server => JSON.parse(readFileSync(path.join(server.authDir, 'access.json'), 'utf8')) as AuthKeys);
      expect(keys[0].secret === keys[1].secret).toBe(false);
      const pages = [await context.newPage(), await context.newPage()];
      const order = reverse ? [1, 0, 1] : [0, 1, 0];
      for (const index of order.slice(0, 2)) await connect(pages[index], servers[index].origin, keys[index]);
      // The first server must still accept its cookie after the other one connects.
      for (const index of [order[2], order[1]]) await assertConnected(context, pages[index], servers[index].origin);
      const ids: string[] = [];
      for (const [index, server] of servers.entries()) {
        // Use the authenticated identity, as in the UI auth spec; keep the
        // servers' default collaboration guard enabled instead of bypassing it.
        const identityResponse = await context.request.get(`${server.origin}/auth/connect`);
        expect(identityResponse.status()).toBe(200);
        const identity = await identityResponse.json();
        const sessionId = `${identity.sessionId}:ports-spec`;
        const registered = await context.request.post(`${server.origin}/api/collaboration/users/register`, {
          data: { userId: identity.userId, sessionId, displayName: `T144 Synthetic Tester ${index}` },
        });
        expect(registered.status()).toBe(200);
        const project = createNewProject(`T144 Synthetic ${reverse ? 'BA' : 'AB'} ${index}`);
        ids.push(project.id);
        const response = await context.request.post(`${server.origin}/api/projects`, {
          headers: { 'x-cfs-user-id': identity.userId, 'x-cfs-session-id': sessionId },
          data: { project, createOnly: true, saveProtocol: SAVE_PROTOCOL_VERSION },
        });
        expect(response.status()).toBe(200);
        const accepted = await response.json();
        const stored = await (await context.request.get(`${server.origin}/api/projects`)).json();
        expect(stored.projects.find((p: { id: string }) => p.id === project.id)).toEqual(accepted.project);
        await assertConnected(context, pages[index], server.origin);
      }
      for (const [index, server] of servers.entries()) {
        const stored = await (await context.request.get(`${server.origin}/api/projects`)).json();
        expect(stored.projects.some((p: { id: string }) => p.id === ids[1 - index])).toBe(false);
      }
    } finally { await context.close(); }
  });
}
