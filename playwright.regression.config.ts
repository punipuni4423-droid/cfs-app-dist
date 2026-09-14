import { baseURL, isolatedSpecs, testStorageState, testPort, testHost } from './tests/playwright-safety';
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import * as path from "path";

const runId =
  process.env.CFS_REGRESSION_RUN_ID ??
  new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");

const artifactRoot =
  process.env.CFS_PLAYWRIGHT_OUTPUT_DIR ??
  path.join(process.cwd(), "artifacts", "playwright", `${runId}-regression`);

if (!/^\.next-[A-Za-z0-9_-]+$/.test(process.env.NEXT_DIST_DIR ?? '')) throw new Error('CFS_TEST_SAFETY: isolated NEXT_DIST_DIR is required.');

const regressionProjects: PlaywrightTestConfig["projects"] = [
  {
    name: 'edit-mode-links',
    testMatch: ['**/cfs_setting_link_*.spec.ts', '**/cfs_setting_overlay_entry.spec.ts', '**/switch_setting_link.spec.ts', '**/cfs_low_high_inline_edit.spec.ts', '**/device_assign_low_high_end.spec.ts', '**/device_assign_zone_multi_circuit.spec.ts', '**/cfs_zone_columns.spec.ts'],
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'remarks',
    testMatch: ['**/remarks_tab.spec.ts', '**/remarks_width.spec.ts'],
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: "protected-behavior",
    testMatch: ["**/protected-behavior.spec.ts", "**/project_save_inflight.spec.ts", "**/project_delete_atomic.spec.ts", "**/project_list_safe.spec.ts", "**/p2_ui_export.spec.ts", "**/critical-auth-scope.spec.ts", "**/critical-save-reliability.spec.ts", "**/storage-quota.spec.ts", "**/project_restore_reliability.spec.ts", "**/header-recovery.spec.ts", "**/import-save-recovery.spec.ts"],
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
  testDir: './tests/e2e',
  testIgnore: isolatedSpecs,
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
    serviceWorkers: 'block',
    storageState: testStorageState(),
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    headless: true,
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev -p ${testPort} -H ${testHost}`,
    url: baseURL,
    reuseExistingServer: process.env.CFS_TEST_REUSE_SERVER === '1',
    timeout: 120000,
  },
  projects: regressionProjects,
});
