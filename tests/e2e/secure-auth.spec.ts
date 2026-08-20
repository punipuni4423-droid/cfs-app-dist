import { expect, test, type Route } from "@playwright/test";
import { createNewProject } from "../../app/lib/storage";

function json(body: unknown): string {
  return JSON.stringify(body);
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: json(body),
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.c2ln`;
}

test("secure sign-in stays signed in when edit status is temporarily unavailable", async ({ page }) => {
  const project = createNewProject("Auth Status Fallback Project");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const publishableKey = fakeJwt({ role: "anon", exp: expiresAt });
  const token = fakeJwt({
    sub: "auth-user",
    email: "admin@example.com",
    exp: expiresAt,
  });

  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, {
      mode: "supabase",
      url: "https://demo.supabase.co",
      publishableKey,
    });
  });
  await page.route("https://demo.supabase.co/**", async (route) => {
    await fulfillJson(route, {
      user: {
        id: "auth-user",
        email: "admin@example.com",
        app_metadata: { provider: "azure" },
        user_metadata: {},
      },
    });
  });
  await page.route("**/api/collaboration/auth", async (route) => {
    await fulfillJson(route, {
      membership: {
        id: "member-1",
        email: "admin@example.com",
        displayName: "Admin User",
        role: "admin",
        active: true,
        createdAt: "2026-08-17T00:00:00.000Z",
        lastSeenAt: "2026-08-17T00:00:00.000Z",
      },
    });
  });
  await page.route("**/api/collaboration/status**", async (route) => {
    await fulfillJson(route, { error: "Failed to read collaboration status." }, 500);
  });
  await page.route("**/api/projects", async (route) => {
    await fulfillJson(route, { projects: [project] });
  });
  await page.route("**/api/trash", async (route) => {
    await fulfillJson(route, { projects: [], roomTypes: [] });
  });
  await page.route("**/api/tablet-url", async (route) => {
    await fulfillJson(route, { url: "" });
  });
  await page.route("**/api/app-update/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      state: "current",
      message: "Latest version installed. Safe to use.",
      ahead: 0,
      behind: 0,
      dirty: false,
      checkedAt: new Date().toISOString(),
      appDir: "mock",
    });
  });

  await page.goto(`/#access_token=${token}&refresh_token=fake-refresh&token_type=bearer&expires_at=${expiresAt}`);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Admin User")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible();
  await expect(page.locator("button.screen-card").filter({ hasText: "Auth Status Fallback Project" })).toBeVisible();
  await expect(page.getByText("Signed in. Shared edit status could not be read")).toBeVisible();
});

test("auth error search params are cleared after returning from provider", async ({ page }) => {
  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, {
      mode: "supabase",
      url: "https://demo.supabase.co",
      publishableKey: fakeJwt({ role: "anon", exp: Math.floor(Date.now() / 1000) + 3600 }),
    });
  });
  await page.route("**/api/projects", async (route) => {
    await fulfillJson(route, { projects: [] });
  });
  await page.route("**/api/trash", async (route) => {
    await fulfillJson(route, { projects: [], roomTypes: [] });
  });
  await page.route("**/api/tablet-url", async (route) => {
    await fulfillJson(route, { url: "" });
  });
  await page.route("**/api/app-update/status**", async (route) => {
    await fulfillJson(route, {
      enabled: true,
      state: "current",
      message: "Latest version installed. Safe to use.",
      ahead: 0,
      behind: 0,
      dirty: false,
      checkedAt: new Date().toISOString(),
      appDir: "mock",
    });
  });

  await page.goto("/?error=access_denied&error_description=cancelled", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL((url) => !url.searchParams.has("error") && !url.searchParams.has("error_description"));
});
