/**
 * 監査#5 (デバイス割当 / Device Assign) 専用 Playwright 設定。
 * 本番 playwright.config.ts は変更しない。
 *
 * OneDrive 配下 (スペース入りパス) に trace を書こうとすると ENOENT で
 * ストールするため、outputDir をローカル一時ディレクトリに逃がし trace は off。
 */
import { defineConfig, devices } from "@playwright/test";
import * as os from "os";
import * as path from "path";

const ARTIFACT_DIR = path.join(os.tmpdir(), "cfs-audit05-artifacts");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/_audit_05_deviceassign.spec.ts",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: ARTIFACT_DIR,
  reporter: [["line"]],
  use: {
    baseURL: "http://localhost:3014",
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
