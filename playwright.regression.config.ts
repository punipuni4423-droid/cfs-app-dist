import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import * as path from "path";

const runId =
  process.env.CFS_REGRESSION_RUN_ID ??
  new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");

const artifactRoot =
  process.env.CFS_PLAYWRIGHT_OUTPUT_DIR ??
  path.join(process.cwd(), "artifacts", "playwright", `${runId}-regression`);

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3014";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const regressionProjects: PlaywrightTestConfig["projects"] = [
  {
    name: "protected-behavior",
    testMatch: "**/protected-behavior.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "shared-edit-toolbar",
    testMatch: "**/_shared_edit_toolbar_ui.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "audit-06-scenes",
    testMatch: "**/_audit_06_scenes.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "audit-07-switches",
    testMatch: "**/_audit_07_switches.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "audit-08-cfs",
    testMatch: "**/_audit_08_cfs.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "audit-10-crosscutting",
    testMatch: "**/_audit_10_crosscutting.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
];

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: path.join(artifactRoot, "test-results"),
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "html-report") }],
    ["json", { outputFile: path.join(artifactRoot, "results.json") }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true,
  },
  webServer: {
    command: `${npmCommand} run dev -- -p 3014`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120000,
  },
  projects: regressionProjects,
});
