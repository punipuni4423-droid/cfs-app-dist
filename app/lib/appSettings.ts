"use client";

import { useEffect, useState } from 'react';
import type { AddressMode, DeviceMaster, InputMaster, TriggerMaster } from '../types';
import {
  APP_SETTINGS_KEY,
  REMOVED_DEFAULT_DEVICE_MODELS,
  createDefaultDevices,
  createDefaultInputMasters,
  createDefaultTriggerMasters,
  inferAddressMode,
} from './constants';
import { createAppId } from './id';

export interface AppSettings {
  devices: DeviceMaster[];
  inputMasters: InputMaster[];
  triggerMasters: TriggerMaster[];
  displayScale: number;
  wattPerPdu: number;
  adminMode: boolean;
  cfsLinkedValueHighlightEnabled: boolean;
  cfsLinkMapEnabled: boolean;
}

const LEGACY_V1_KEY = 'cfs-app-settings-v1';
const LEGACY_V1_BACKUP_KEY = 'cfs-app-settings-v1-backup';
const LEGACY_V2_KEY = 'cfs-app-settings-v2';
const LEGACY_V2_BACKUP_KEY = 'cfs-app-settings-v2-backup';
const APP_SETTINGS_CHANGE_EVENT = 'cfs-app-settings-change';
const DEFAULT_WATT_PER_PDU = 3.3;

function safeSetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error('Failed to save app settings to localStorage.', error);
    window.alert(
      'Failed to save settings. Check the browser storage capacity and try again.',
    );
    return false;
  }
}

// Tolerant validator: accepts records that may or may not include addressMode
// (legacy v1 data lacks the field; loadAppSettings normalizes it).
function isDeviceMaster(value: unknown): value is DeviceMaster {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const addressModeOk =
    !('addressMode' in v) || typeof v.addressMode === 'string';
  const pduOk = !('pdu' in v) || typeof v.pdu === 'string';
  const wattsOk = !('watts' in v) || typeof v.watts === 'string';
  const programmingCodeOk =
    !('programmingCode' in v) || typeof v.programmingCode === 'string';
  return (
    typeof v.id === 'string' &&
    typeof v.model === 'string' &&
    typeof v.control === 'string' &&
    typeof v.abbrev === 'string' &&
    programmingCodeOk &&
    typeof v.lowEnd === 'string' &&
    typeof v.highEnd === 'string' &&
    typeof v.isDefault === 'boolean' &&
    addressModeOk &&
    pduOk &&
    wattsOk
  );
}

function isAppSettings(value: unknown): value is AppSettings {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const inputMastersOk =
    !('inputMasters' in v) ||
    (Array.isArray(v.inputMasters) && v.inputMasters.every(isInputMaster));
  const triggerMastersOk =
    !('triggerMasters' in v) ||
    (Array.isArray(v.triggerMasters) && v.triggerMasters.every(isTriggerMaster));
  const displayScaleOk =
    !('displayScale' in v) || typeof v.displayScale === 'number';
  const wattPerPduOk =
    !('wattPerPdu' in v) || typeof v.wattPerPdu === 'number';
  const adminModeOk =
    !('adminMode' in v) || typeof v.adminMode === 'boolean';
  const linkedValueHighlightOk =
    !('cfsLinkedValueHighlightEnabled' in v) ||
    typeof v.cfsLinkedValueHighlightEnabled === 'boolean';
  const linkMapOk =
    !('cfsLinkMapEnabled' in v) || typeof v.cfsLinkMapEnabled === 'boolean';
  return (
    Array.isArray(v.devices) &&
    v.devices.every(isDeviceMaster) &&
    inputMastersOk &&
    triggerMastersOk &&
    displayScaleOk &&
    wattPerPduOk &&
    adminModeOk &&
    linkedValueHighlightOk &&
    linkMapOk
  );
}

function defaults(): AppSettings {
  return {
    devices: createDefaultDevices(),
    inputMasters: createDefaultInputMasters(),
    triggerMasters: createDefaultTriggerMasters(),
    displayScale: 1,
    wattPerPdu: DEFAULT_WATT_PER_PDU,
    adminMode: false,
    cfsLinkedValueHighlightEnabled: false,
    cfsLinkMapEnabled: false,
  };
}

const DEFAULT_SETTINGS: AppSettings = defaults();

function normalizeAddressMode(value: unknown, model: string): AddressMode {
  if (value === 'fixed' || value === 'dali') return value;
  return inferAddressMode(model);
}

function normalizeDevice(raw: unknown): DeviceMaster | null {
  if (raw === null || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const model = typeof d.model === 'string' ? d.model : '';
  const device: DeviceMaster = {
    id: typeof d.id === 'string' ? d.id : createAppId(),
    model,
    control: typeof d.control === 'string' ? d.control : '',
    abbrev: typeof d.abbrev === 'string' ? d.abbrev : '',
    programmingCode:
      typeof d.programmingCode === 'string'
        ? d.programmingCode
        : typeof d.abbrev === 'string'
          ? d.abbrev
          : '',
    lowEnd: typeof d.lowEnd === 'string' ? d.lowEnd : '',
    highEnd: typeof d.highEnd === 'string' ? d.highEnd : '',
    isDefault: typeof d.isDefault === 'boolean' ? d.isDefault : false,
    addressMode: normalizeAddressMode(d.addressMode, model),
    pdu: typeof d.pdu === 'string' ? d.pdu : '0',
    watts: typeof d.watts === 'string' ? d.watts : '',
  };
  return device;
}

function mergeDefaultDevices(devices: DeviceMaster[]): DeviceMaster[] {
  const defaults = createDefaultDevices();
  const defaultsByModel = new Map(defaults.map((device) => [device.model, device]));
  const removedDefaultModels = new Set(REMOVED_DEFAULT_DEVICE_MODELS);
  const seenModels = new Set<string>();

  const normalized = devices
    .filter((device) => !(device.isDefault && removedDefaultModels.has(device.model)))
    .map((device) => {
      const defaultDevice = defaultsByModel.get(device.model);
      if (defaultDevice) seenModels.add(device.model);
      const control = device.model === 'CorridorPico' && defaultDevice
        ? defaultDevice.control
        : device.control;
      return {
        ...device,
        control,
        isDefault: device.isDefault || Boolean(defaultDevice?.isDefault),
        addressMode: device.addressMode ?? defaultDevice?.addressMode ?? inferAddressMode(device.model),
        programmingCode:
          typeof device.programmingCode === 'string' && device.programmingCode.trim() !== ''
            ? device.programmingCode
            : defaultDevice?.programmingCode ?? device.abbrev,
        pdu: typeof device.pdu === 'string' ? device.pdu : defaultDevice?.pdu ?? '0',
        watts: typeof device.watts === 'string' ? device.watts : defaultDevice?.watts ?? '',
      };
    });

  const missingDefaults = defaults.filter((device) => !seenModels.has(device.model));
  return [...normalized, ...missingDefaults];
}

function isInputMaster(value: unknown): value is InputMaster {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string';
}

function normalizeInputMaster(raw: unknown): InputMaster | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  return {
    id: typeof m.id === 'string' ? m.id : createAppId(),
    name: typeof m.name === 'string' ? m.name : '',
  };
}

function isTriggerMaster(value: unknown): value is TriggerMaster {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string';
}

function normalizeTriggerMaster(raw: unknown): TriggerMaster | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  return {
    id: typeof m.id === 'string' ? m.id : createAppId(),
    name: typeof m.name === 'string' ? m.name : '',
  };
}

function normalizeSettings(parsed: unknown): AppSettings {
  if (parsed === null || typeof parsed !== 'object') return defaults();
  const p = parsed as Record<string, unknown>;
  const devicesRaw = Array.isArray(p.devices) ? p.devices : [];
  const inputMastersRaw = Array.isArray(p.inputMasters) ? p.inputMasters : [];
  const triggerMastersRaw = Array.isArray(p.triggerMasters) ? p.triggerMasters : [];
  const devices = devicesRaw
    .map(normalizeDevice)
    .filter((d): d is DeviceMaster => d !== null);
  const inputMasters = inputMastersRaw
    .map(normalizeInputMaster)
    .filter((m): m is InputMaster => m !== null);
  const triggerMasters = triggerMastersRaw
    .map(normalizeTriggerMaster)
    .filter((m): m is TriggerMaster => m !== null);
  const displayScale =
    typeof p.displayScale === 'number' && Number.isFinite(p.displayScale)
      ? Math.min(1.5, Math.max(0.5, p.displayScale))
      : DEFAULT_SETTINGS.displayScale;
  const wattPerPdu =
    typeof p.wattPerPdu === 'number' && Number.isFinite(p.wattPerPdu) && p.wattPerPdu > 0
      ? p.wattPerPdu
      : DEFAULT_SETTINGS.wattPerPdu;
  const mergedDevices = mergeDefaultDevices(devices.length > 0 ? devices : DEFAULT_SETTINGS.devices);
  return {
    ...DEFAULT_SETTINGS,
    devices: mergedDevices,
    inputMasters:
      inputMasters.length > 0 ? inputMasters : DEFAULT_SETTINGS.inputMasters,
    triggerMasters:
      triggerMasters.length > 0 ? triggerMasters : DEFAULT_SETTINGS.triggerMasters,
    displayScale,
    wattPerPdu,
    adminMode: typeof p.adminMode === 'boolean' ? p.adminMode : DEFAULT_SETTINGS.adminMode,
    cfsLinkedValueHighlightEnabled:
      typeof p.cfsLinkedValueHighlightEnabled === 'boolean'
        ? p.cfsLinkedValueHighlightEnabled
        : DEFAULT_SETTINGS.cfsLinkedValueHighlightEnabled,
    cfsLinkMapEnabled:
      typeof p.cfsLinkMapEnabled === 'boolean'
        ? p.cfsLinkMapEnabled
        : DEFAULT_SETTINGS.cfsLinkMapEnabled,
  };
}

export function loadAppSettings(): AppSettings {
  if (typeof window === 'undefined') return defaults();

  // 1. v3 first
  const v3 = window.localStorage.getItem(APP_SETTINGS_KEY);
  if (v3) {
    try {
      const parsed: unknown = JSON.parse(v3);
      if (isAppSettings(parsed)) {
        const normalized = normalizeSettings(parsed);
        if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
          safeSetItem(APP_SETTINGS_KEY, JSON.stringify(normalized));
        }
        return normalized;
      }
    } catch {
      /* fall-through */
    }
  }

  // 2. v2 migration
  const v2 = window.localStorage.getItem(LEGACY_V2_KEY);
  if (v2) {
    try {
      const parsed: unknown = JSON.parse(v2);
      if (isAppSettings(parsed)) {
        const migrated = normalizeSettings(parsed);
        if (safeSetItem(APP_SETTINGS_KEY, JSON.stringify(migrated))) {
          safeSetItem(LEGACY_V2_BACKUP_KEY, v2);
          window.localStorage.removeItem(LEGACY_V2_KEY);
        }
        return migrated;
      }
    } catch {
      /* ignore */
    }
  }

  // 3. v1 migration
  const v1 = window.localStorage.getItem(LEGACY_V1_KEY);
  if (v1) {
    try {
      const parsed: unknown = JSON.parse(v1);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>).devices)
      ) {
        const migrated = normalizeSettings(parsed);
        if (safeSetItem(APP_SETTINGS_KEY, JSON.stringify(migrated))) {
          safeSetItem(LEGACY_V1_BACKUP_KEY, v1);
          window.localStorage.removeItem(LEGACY_V1_KEY);
        }
        return migrated;
      }
    } catch {
      /* ignore */
    }
  }

  return defaults();
}

export function saveAppSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  safeSetItem(APP_SETTINGS_KEY, JSON.stringify(settings));
}

// Hook that loads settings client-side and listens for cross-tab updates.
export function useAppSettings(): {
  settings: AppSettings;
  setSettings: (next: AppSettings) => void;
} {
  const [settings, setSettingsState] = useState<AppSettings>(defaults());

  useEffect(() => {
    setSettingsState(loadAppSettings());
    const reloadSettings = () => setSettingsState(loadAppSettings());
    const handler = (e: StorageEvent) => {
      if (e.key === APP_SETTINGS_KEY) {
        reloadSettings();
      }
    };
    window.addEventListener('storage', handler);
    window.addEventListener(APP_SETTINGS_CHANGE_EVENT, reloadSettings);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(APP_SETTINGS_CHANGE_EVENT, reloadSettings);
    };
  }, []);

  function setSettings(next: AppSettings): void {
    setSettingsState(next);
    saveAppSettings(next);
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGE_EVENT));
  }

  return { settings, setSettings };
}
