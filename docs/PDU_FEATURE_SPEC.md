# PDU Calculation Feature Specification

## Overview

Add a PDU (Power Draw Unit) calculation tab to the CFS app that calculates Lutron device power consumption per room type, combined with lighting fixture VA to determine total power demand and breaker requirements.

## Architecture Context

- **Framework**: Next.js 15, React, TypeScript
- **Persistence**: localStorage with versioned STORAGE_KEY migration pattern
- **Current STORAGE_KEY**: `cfs-projects-v13` (will become v14 after this feature)
- **Settings**: `APP_SETTINGS_KEY = 'cfs-app-settings-v2'` (will become v3)
- **Key files**:
  - `app/types.ts` — All TypeScript interfaces
  - `app/lib/constants.ts` — Factory functions, constants
  - `app/lib/appSettings.ts` — AppSettings load/save/migrate
  - `app/lib/storage.ts` — Project data load/save/migrate
  - `app/components/ProjectScreen.tsx` — Main screen with tabs
  - `app/settings/devices/page.tsx` — Settings page

## Feature Requirements

### 1. DeviceMaster Extension

Extend the existing `DeviceMaster` interface with PDU-related fields:

```typescript
export interface DeviceMaster {
  id: string;
  model: string;
  control: string;
  abbrev: string;
  lowEnd: string;
  highEnd: string;
  isDefault: boolean;
  addressMode: AddressMode;
  // NEW FIELDS:
  pdu: string;       // PDU value (positive = supply, negative = consume, "0" = neutral)
  watts: string;     // Direct watt consumption (optional, for devices with known W)
}
```

### 2. AppSettings Extension

Add a global `wattPerPdu` conversion factor:

```typescript
export interface AppSettings {
  devices: DeviceMaster[];
  inputMasters: InputMaster[];
  triggerMasters: TriggerMaster[];
  displayScale: number;
  // NEW:
  wattPerPdu: number;  // Default: 3.3 (1 PDU = 3.3VA)
}
```

### 3. Settings UI Update (`/settings/devices`)

- Add "PDU" and "W" columns to the Device Master table
- Add a "PDU Settings" section with `wattPerPdu` input field (default: 3.3)
- Migrate existing devices: set `pdu: '0'` and `watts: ''` for all existing entries

### 4. Default Device PDU Values

When creating default devices or migrating, apply these PDU values:

| Model | PDU | Watts |
|-------|-----|-------|
| MP-1L-GCU | -8 | 4.2 |
| GCU-HOSP | -8 | 5.0 |
| HQP7-1 | -8 | 4.2 |
| QSPS-DH-1-75 | +75 | |
| MQSE-4A1-D | +4 | |
| MQSE-4S1-D | +4 | |
| QSN-4P20-D | 0 | |
| QSN2-1DALUNV-D | 0 | |
| QSN2-2DALUNV-D | 0 | |
| QSE-IO | -3 | |
| QSE-CI-WCI | -1 | |
| SMC53-MYRM | -5 | 4.0 |
| SMC55-MYRM | -5 | 4.0 |
| QSM | -3 | |
| Wireless OCC | 0 | |
| Palladiom Keypad | -1 | |
| Pico Remote | 0 | |

Note: MQSE-4S1-D, MQSE-4A1-D, QSN-4P20-D, QSN2-1DALUNV-D, QSN2-2DALUNV-D, QSE-IO, QSE-CI-WCI are already in the default device list. The rest are new additions to the default set. New devices should have `isDefault: true` but should NOT appear in DeviceAssign tab selection (see constraint below).

### 5. DeviceAssign Tab Constraint

The DeviceAssign tab device selector must ONLY show devices that have an `addressMode` and associated zone/address configuration (i.e., entries in the `DEVICE_ADDRESSES` map in constants.ts). The new PDU-only devices (processors, power supplies, sensors, keypads, remotes) do NOT have address configurations and should NOT be selectable in DeviceAssign.

Keep the existing DeviceAssign device selection logic unchanged. Only devices with entries in `DEVICE_ADDRESSES` are selectable there.

### 6. New RoomsSubTab: "PDU"

Add `'pdu'` to `RoomsSubTab` type:

```typescript
export type RoomsSubTab = 'circuit' | 'deviceAssign' | 'areaScene' | 'scene' | 'switch' | 'command' | 'backlight' | 'cfs' | 'pdu';
```

Add the tab after "CFS" in ProjectScreen.tsx subTabs array.

### 7. PDU View Component (`PduView.tsx`)

Create `app/components/PduView.tsx` with the following sections:

#### Section A: Lutron Device PDU Summary

A table showing:
- Device model (from DeviceMaster, filtered to those with non-empty `pdu`)
- PDU per unit
- Quantity used in this room (auto-counted from DeviceAssignments by matching `device` field)
- For devices NOT in DeviceAssign (processors, power supplies, keypads, etc.): manual quantity input per room type
- Total PDU per device row (pdu * quantity)
- **Grand Total PDU** (sum of all rows — should be >= 0 for valid design)

Display a warning if total PDU < 0 (over budget).

#### Section B: Lighting Fixture VA Summary

A table showing:
- Fixture name (from project's `fixtures` FixtureMaster[])
- Unit VA (calculated via existing `fixtureUnitVa()` function)
- Total pcs used (summed from CircuitEntry[] in the room type)
- Total VA per fixture (unit VA * pcs)
- **Grand Total Fixture VA**

#### Section C: Lutron Device Watt Consumption

Calculate total watt consumption of Lutron devices:
- For devices with direct `watts` value: watts * quantity
- For devices without `watts` but with `pdu`: |pdu| * wattPerPdu * quantity
- **Grand Total Lutron W**

#### Section D: Total Power Summary

| Item | Value |
|------|-------|
| Lighting Fixture Total VA | (from Section B) |
| Lutron Device Total W | (from Section C) |
| **Combined Total VA** | Fixture VA + Lutron W (treat W as VA for conservative estimate) |
| Voltage | 100V (fixed) |
| **Total Current (A)** | Combined VA / 100 |
| Breaker Rating | 20A |
| **Breakers Required** | ceil(Total A / 20) |

#### Section E: Per-Room Device Quantities (Stored in RoomType)

For devices not auto-counted from DeviceAssign (processors, power supplies, keypads, sensors, remotes), store manual quantity overrides per room type:

```typescript
// Add to RoomType interface:
export interface PduDeviceCount {
  deviceId: string;   // DeviceMaster.id
  quantity: number;
}

export interface RoomType {
  // ... existing fields ...
  pduDeviceCounts: PduDeviceCount[];  // NEW
}
```

### 8. Migration Requirements

#### STORAGE_KEY: `cfs-projects-v13` -> `cfs-projects-v14`

- Add `pduDeviceCounts: []` to all existing RoomType objects

#### APP_SETTINGS_KEY: `cfs-app-settings-v2` -> `cfs-app-settings-v3`

- Add `pdu: '0'` and `watts: ''` to all existing DeviceMaster entries
- Add `wattPerPdu: 3.3` to settings
- Add new default devices (MP-1L-GCU, GCU-HOSP, HQP7-1, QSPS-DH-1-75, SMC53-MYRM, SMC55-MYRM, QSM, Wireless OCC, Palladiom Keypad, Pico Remote) with `isDefault: true`
- Update existing defaults with correct PDU values:
  - MQSE-4S1-D: pdu = '+4'
  - MQSE-4A1-D: pdu = '+4'
  - QSN-4P20-D: pdu = '0'
  - QSN2-1DALUNV-D: pdu = '0'
  - QSN2-2DALUNV-D: pdu = '0'
  - QSE-IO: pdu = '-3'
  - QSE-CI-WCI: pdu = '-1'

### 9. Calculation Logic

```typescript
// PDU calculation for a room type
function calculatePduSummary(
  roomType: RoomType,
  devices: DeviceMaster[],
  fixtures: FixtureMaster[],
  circuits: CircuitEntry[],
  wattPerPdu: number,
): PduSummary {
  // 1. Count devices from DeviceAssign (auto)
  const assignCounts = countDevicesFromAssignments(roomType.deviceAssignments, devices);

  // 2. Get manual counts for non-assign devices
  const manualCounts = roomType.pduDeviceCounts;

  // 3. Calculate PDU total
  const pduTotal = calculatePduTotal(assignCounts, manualCounts, devices);

  // 4. Calculate fixture VA total
  const fixtureVaTotal = calculateFixtureVa(circuits, fixtures);

  // 5. Calculate Lutron device watts
  const lutronWatts = calculateLutronWatts(assignCounts, manualCounts, devices, wattPerPdu);

  // 6. Combined total
  const combinedVa = fixtureVaTotal + lutronWatts;
  const totalAmps = combinedVa / 100; // 100V fixed
  const breakersRequired = Math.ceil(totalAmps / 20);

  return { pduTotal, fixtureVaTotal, lutronWatts, combinedVa, totalAmps, breakersRequired };
}
```

### 10. UI/UX Notes

- Follow existing app CSS patterns: `matrix-table`, `card card-padded`, etc.
- Use existing color coding for warnings (red when PDU < 0)
- Green indicator when PDU budget is healthy (>= 0)
- Breaker count should be prominently displayed
- Manual quantity inputs should use the same `cell-input` class pattern
- Auto-counted values from DeviceAssign should show as read-only with a note "(auto)"

### 11. Files to Create/Modify

#### New Files:
- `app/components/PduView.tsx` — Main PDU calculation view

#### Modified Files:
- `app/types.ts` — Add `PduDeviceCount`, extend `RoomType`, extend `RoomsSubTab`
- `app/lib/constants.ts` — Add `createEmptyPduDeviceCount()`, update `createNewRoomType()`, add new default devices to `DEFAULT_DEVICES_DATA`, add PDU calculation helpers
- `app/lib/appSettings.ts` — Bump to v3, add `wattPerPdu`, migrate existing devices with PDU fields, add new defaults
- `app/lib/storage.ts` — Bump STORAGE_KEY to v14, migrate RoomType with `pduDeviceCounts`
- `app/components/ProjectScreen.tsx` — Add 'pdu' sub-tab, render PduView
- `app/settings/devices/page.tsx` — Add wattPerPdu setting input
- `app/components/DevicesView.tsx` — Add PDU and W columns to device master table

### 12. Important Constraints

- **Immutable updates only** — Never mutate state directly
- **Backward compatible migration** — Always handle missing fields with defaults
- **DeviceAssign unchanged** — Only devices with DEVICE_ADDRESSES entries are selectable
- **0 PDU devices still shown in PDU tab** — Even if PDU=0, show them for completeness
- **Positive PDU = power supply** — Display clearly that + means supply, - means consumption
- **Palladiom Keypad** — PDU is -1 per unit (quantity = number of keypads in room)
