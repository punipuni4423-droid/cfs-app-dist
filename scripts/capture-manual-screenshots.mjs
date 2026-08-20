import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.CFS_MANUAL_SCREENSHOT_BASE_URL || "http://localhost:3024";
const outputDir = path.resolve(process.cwd(), "docs/assets/cfs_usage_common_20260715");
const manualUser = {
  id: "user:manual-doc",
  displayName: "Manual Sample User",
  email: "manual@example.invalid",
  role: "admin",
  createdAt: new Date().toISOString(),
  lastSeenAt: null,
};
const manualSessionId = "session:manual-doc";

function createManualProject() {
  const now = new Date().toISOString();
  const locations = [
    { id: "manual-area-entrance", name: "Entrance", number: "1", code: "1", color: "#FFC7CE" },
    { id: "manual-area-bedroom", name: "Bedroom", number: "2", code: "2", color: "#C6EFCE" },
    { id: "manual-area-vanity", name: "Vanity", number: "3", code: "3", color: "#D9EAF7" },
  ];
  const fixtures = [
    { id: "manual-fixture-dl", fixture: "DL-01 Downlight", fixtureType: "DL", powerMode: "VA", watt: "12", powerFactor: "0.7" },
    { id: "manual-fixture-indirect", fixture: "ID-01 Indirect", fixtureType: "Indirect", powerMode: "W", watt: "9.6", powerFactor: "0.7" },
  ];
  const circuits = [
    {
      id: "manual-circuit-d1",
      circuitGroupId: "manual-circuit-group-d1",
      daliFixtureGroupId: "",
      designerNumber: "D-1",
      internalNumber: "L01",
      dimmingType: "Phase",
      fixture: fixtures[0].fixture,
      pcs: "4",
      detail: "Downlight Entrance",
      area: locations[0].id,
      ffe: false,
      energySaving: false,
    },
    {
      id: "manual-circuit-d2",
      circuitGroupId: "manual-circuit-group-d2",
      daliFixtureGroupId: "",
      designerNumber: "D-2",
      internalNumber: "L02",
      dimmingType: "On/Off",
      fixture: fixtures[1].fixture,
      pcs: "1.5",
      detail: "Indirect Bedroom",
      area: locations[1].id,
      ffe: true,
      energySaving: false,
    },
    {
      id: "manual-circuit-d3",
      circuitGroupId: "manual-circuit-group-d3",
      daliFixtureGroupId: "manual-dali-fixture-group",
      designerNumber: "D-3",
      internalNumber: "L03",
      dimmingType: "DALI",
      fixture: fixtures[0].fixture,
      pcs: "1",
      detail: "DALI Vanity",
      area: locations[2].id,
      ffe: false,
      energySaving: true,
    },
  ];
  const scenes = [
    {
      id: "manual-scene-bright",
      areaId: locations[0].id,
      name: "Bright",
      settings: [
        { circuitId: circuits[0].id, percentage: "100" },
        { circuitId: circuits[1].id, percentage: "On" },
      ],
    },
    {
      id: "manual-scene-night",
      areaId: locations[1].id,
      name: "Night",
      settings: [
        { circuitId: circuits[1].id, percentage: "Off" },
        { circuitId: circuits[2].id, percentage: "20" },
      ],
    },
  ];
  const baseButtonSetting = (circuitSettings) => ({
    sceneId: "",
    sceneIds: [],
    circuitSettings,
  });
  const roomType = {
    id: "manual-room-a",
    name: "A",
    updatedAt: now,
    revision: "1.00",
    revisions: [],
    rows: [],
    deviceAssignments: [
      {
        id: "manual-assign-a1",
        deviceGroupId: "manual-device-group-a",
        device: "MQSE-4A1-D",
        deviceNum: "1",
        zoneAddress: "Zn1",
        circuitNumber: "D-1",
        detail: "",
        group: "",
      },
      {
        id: "manual-assign-a2",
        deviceGroupId: "manual-device-group-a",
        device: "MQSE-4A1-D",
        deviceNum: "1",
        zoneAddress: "Zn2",
        circuitNumber: "D-2",
        detail: "",
        group: "",
      },
      {
        id: "manual-assign-dali1",
        deviceGroupId: "manual-device-group-dali",
        device: "QSN2-1DALUNV-D",
        deviceNum: "1",
        zoneAddress: "1",
        circuitNumber: "D-3",
        detail: "",
        group: "G1",
      },
      {
        id: "manual-assign-reserved",
        deviceGroupId: "manual-device-group-a",
        device: "MQSE-4A1-D",
        deviceNum: "1",
        zoneAddress: "Zn3",
        circuitNumber: "",
        detail: "Spare",
        group: "",
      },
    ],
    hvacAssignments: [
      {
        id: "manual-hvac-1",
        protocol: "Modbus",
        thermostatRole: "Master",
        area: locations[1].id,
        lowEnd: "18",
        highEnd: "28",
        summerWinterChange: true,
        note: "Guest room FCU",
      },
    ],
    hvacSeasons: [
      { id: "manual-season-summer", name: "Summer", startMonth: "6", startDay: "1", endMonth: "9", endDay: "30" },
      { id: "manual-season-winter", name: "Winter", startMonth: "12", startDay: "1", endMonth: "3", endDay: "31" },
    ],
    scenes,
    roomScenes: [
      {
        id: "manual-room-scene-check-in",
        phase: "Check In",
        sceneType: "Welcome",
        detail: "Guest arrival",
        triggerCondition: "Door open",
        backlightCondition: "",
        areaSceneSelections: [{ areaId: locations[0].id, sceneId: scenes[0].id }],
        settings: [
          { circuitId: circuits[0].id, percentage: "100" },
          { circuitId: circuits[2].id, percentage: "50" },
        ],
      },
      {
        id: "manual-room-scene-check-out",
        phase: "Check Out",
        sceneType: "Away",
        detail: "Room empty",
        triggerCondition: "Card out",
        backlightCondition: "",
        areaSceneSelections: [{ areaId: locations[1].id, sceneId: scenes[1].id }],
        settings: [{ circuitId: circuits[0].id, percentage: "0" }],
      },
    ],
    switches: [
      {
        id: "manual-switch-contact",
        switchGroupId: "manual-switch-group-contact",
        kind: "contact",
        switchNumber: "CI1",
        switchName: "Door Contact",
        cciAssignment: "CCI-1",
        buttonCount: "1",
        buttonLabel: "Trigger",
        allocation: "Entrance",
        buttonFunction: "Check In",
        buttonType: "single",
        condition: "Door open",
        buttonSetting: baseButtonSetting([{ circuitId: circuits[0].id, percentage: "100" }]),
        backlightTarget: "",
        backlightCondition: "",
        backlightLevels: [],
      },
      {
        id: "manual-switch-pico",
        switchGroupId: "manual-switch-group-pico",
        kind: "lutronPico",
        switchNumber: "SW1",
        switchName: "Bedside Pico",
        cciAssignment: "",
        buttonCount: "5",
        buttonLabel: "On",
        allocation: "Bedroom",
        buttonFunction: "Bright Recall",
        buttonType: "scene",
        condition: "",
        buttonSetting: {
          sceneId: scenes[0].id,
          sceneIds: [scenes[0].id],
          circuitSettings: [],
        },
        backlightTarget: "",
        backlightCondition: "",
        backlightLevels: [],
      },
    ],
    pduDeviceCounts: [
      { deviceId: "manual-pdu-mqse", quantity: 1 },
      { deviceId: "manual-pdu-qsn", quantity: 1 },
    ],
    inspectionMarks: [],
  };

  return {
    id: "manual-project",
    name: "Manual Sample Project",
    updatedAt: now,
    locations,
    fixtures,
    circuits,
    roomTypes: [roomType],
  };
}

function asJson(body) {
  return JSON.stringify(body);
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: asJson(body),
  });
}

function requestJson(route) {
  try {
    const parsed = route.request().postDataJSON();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function installManualLocalEditingMocks(page) {
  const state = {
    projects: [createManualProject()],
    trash: { projects: [], roomTypes: [] },
  };

  await page.route("**/api/sharing/config", async (route) => {
    await fulfillJson(route, { mode: "local" });
  });

  await page.route("**/api/collaboration/status**", async (route) => {
    await fulfillJson(route, {
      enabled: false,
      mode: "local",
      lock: null,
      lastUpdatedBy: null,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs: 15 * 60 * 1000,
    });
  });

  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      const payload = requestJson(route);
      state.projects = Array.isArray(payload.projects) ? payload.projects : [];
      await fulfillJson(route, { ok: true, projects: state.projects });
      return;
    }
    await fulfillJson(route, { projects: state.projects });
  });

  await page.route("**/api/trash", async (route) => {
    if (route.request().method() === "POST") {
      const payload = requestJson(route);
      const rawTrash = payload.trash && typeof payload.trash === "object" ? payload.trash : payload;
      state.trash = {
        projects: Array.isArray(rawTrash.projects) ? rawTrash.projects : [],
        roomTypes: Array.isArray(rawTrash.roomTypes) ? rawTrash.roomTypes : [],
      };
      await fulfillJson(route, { ok: true, trash: state.trash });
      return;
    }
    await fulfillJson(route, state.trash);
  });

  await page.route("**/api/app-update/status", async (route) => {
    await fulfillJson(route, { status: "idle" });
  });
}

async function ensureCleanDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function waitForApp(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "CFS Project Selection" }).waitFor({ timeout: 20000 });
}

async function capture(page, name, locator = null) {
  await page.waitForTimeout(250);
  const target = locator || page;
  await target.screenshot({ path: path.join(outputDir, name) });
}

async function clickIfVisible(locator) {
  if ((await locator.count()) > 0 && await locator.first().isVisible()) {
    try {
      await locator.first().click({ timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function fillFirstVisible(page, labelOrPlaceholder, value) {
  const byLabel = page.getByLabel(labelOrPlaceholder, { exact: true });
  if ((await byLabel.count()) > 0 && await byLabel.first().isVisible()) {
    await byLabel.first().fill(value);
    return true;
  }
  const byPlaceholder = page.getByPlaceholder(labelOrPlaceholder, { exact: true });
  if ((await byPlaceholder.count()) > 0 && await byPlaceholder.first().isVisible()) {
    await byPlaceholder.first().fill(value);
    return true;
  }
  return false;
}

async function startEditing(page) {
  await clickIfVisible(page.getByRole("button", { name: "Start Editing", exact: true }));
  if (await page.getByLabel("Display Name", { exact: true }).isVisible().catch(() => false)) {
    await fillFirstVisible(page, "Display Name", "Manual Sample User");
    await clickIfVisible(page.getByRole("button", { name: "Register", exact: true }));
    await page.locator(".collaboration-user-backdrop").waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
  }
  await clickIfVisible(page.getByRole("button", { name: "Edit", exact: true }));
  if ((await page.getByRole("button", { name: "Finish Editing", exact: true }).count()) === 0) {
    await clickIfVisible(page.getByRole("button", { name: "Start Editing", exact: true }));
  }
  await page.waitForTimeout(250);
}

async function createOrOpenSampleProject(page) {
  const projectName = "Manual Sample Project";
  await startEditing(page);
  const existing = page.locator("button.screen-card").filter({ hasText: projectName }).first();
  if ((await existing.count()) > 0 && await existing.isVisible()) {
    await existing.click();
    return;
  }
  const testProject = page.locator("button.screen-card").filter({ hasText: /^Test$/ }).first();
  if ((await testProject.count()) > 0 && await testProject.isVisible()) {
    await testProject.click();
    return;
  }
  const nameInput = page.getByPlaceholder("New project name", { exact: true });
  await nameInput.fill(projectName);
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await page.waitForTimeout(500);
}

async function openMainTab(page, name) {
  const tab = page.locator('[role="tab"]').filter({ hasText: name }).first();
  await tab.click({ timeout: 8000 });
  await page.waitForTimeout(250);
}

async function openRoomType(page) {
  await openMainTab(page, "Room Type");
  const roomTab = page.getByRole("tab", { name: "A", exact: true });
  if ((await roomTab.count()) > 0 && await roomTab.first().isVisible()) {
    await roomTab.first().click();
    await page.waitForTimeout(250);
    return;
  }
  const roomNameInput = page.getByPlaceholder("New room type name", { exact: true });
  if ((await roomNameInput.count()) > 0 && await roomNameInput.first().isVisible()) {
    await roomNameInput.first().fill("A");
    await page.getByRole("button", { name: "Create Room Type", exact: true }).click();
    await page.waitForTimeout(500);
  }
}

async function openSubTab(page, name) {
  const tab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${name}$`) }).first();
  await tab.click({ timeout: 8000 });
  await page.waitForTimeout(300);
}

async function tryAddOneCircuit(page) {
  await openMainTab(page, "Circuit");
  const addButton = page.getByRole("button", { name: /\+ Circuit Add|\+ Add Circuit|Add Circuit|Add row/i }).first();
  if ((await addButton.count()) > 0 && await addButton.isVisible()) {
    await addButton.click();
    await page.waitForTimeout(200);
  }
}

async function run() {
  await ensureCleanDir(outputDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ user, sessionId }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("cfs-collaboration-user-v1", JSON.stringify(user));
    window.sessionStorage.setItem("cfs-collaboration-session-v1", sessionId);
  }, { user: manualUser, sessionId: manualSessionId });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept().catch(() => undefined));
  await installManualLocalEditingMocks(page);

  try {
    await waitForApp(page);
    await capture(page, "01-project-selection.png");

    await createOrOpenSampleProject(page);
    await page.getByText(/Room Type List/i).waitFor({ timeout: 10000 });
    await capture(page, "02-project-overview.png");

    await openMainTab(page, "Area");
    await capture(page, "03-area-master.png");

    await openMainTab(page, "Fixture");
    await capture(page, "04-fixture-master.png");

    await openRoomType(page);
    await capture(page, "05-room-type-workspace.png");

    for (const [tabName, fileName] of [
      ["PDU", "06-pdu-tab.png"],
      ["Circuit", "07-circuit-tab.png"],
      ["Device Assign", "08-device-assign-tab.png"],
      ["Area Scene", "09-area-scene-tab.png"],
      ["Scene", "10-scene-tab.png"],
      ["Switch", "11-switch-tab.png"],
      ["Command", "12-command-tab.png"],
      ["Backlight", "13-backlight-tab.png"],
      ["CFS", "14-cfs-tab.png"],
    ]) {
      await openSubTab(page, tabName);
      await capture(page, fileName);
    }

    const inspectionMode = page.getByRole("button", { name: "InspectionMode", exact: true });
    if ((await inspectionMode.count()) > 0) {
      await inspectionMode.first().click();
      const dialog = page.getByRole("dialog", { name: "Start InspectionMode", exact: true });
      if ((await dialog.count()) > 0) {
        await dialog.first().waitFor({ state: "visible", timeout: 5000 });
        await capture(page, "15-inspection-start-dialog.png");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
    }

    const revision = page.getByRole("button", { name: "Revision Management", exact: true });
    if ((await revision.count()) > 0) {
      await revision.first().click();
      await capture(page, "16-revision-management.png");
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    await page.goto(`${baseUrl}/settings/devices`, { waitUntil: "networkidle" });
    await capture(page, "17-settings-devices.png");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await capture(page, "18-mobile-project-selection.png");
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
