"use client";

import { useEffect, useState } from "react";
import type { DeviceMaster, InputMaster, TriggerMaster } from "../types";
import { useAppSettings } from "../lib/appSettings";
import DevicesView from "./DevicesView";
import InputMastersView from "./InputMastersView";
import TriggerMastersView from "./TriggerMastersView";
import DisplaySettingsView from "./DisplaySettingsView";

type SettingsTab = "devices" | "inputs" | "triggers" | "display";

interface AppSettingsPanelProps {
  embedded?: boolean;
}

export default function AppSettingsPanel({ embedded = false }: AppSettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("devices");
  const { settings, setSettings } = useAppSettings();
  const [wattPerPduDraft, setWattPerPduDraft] = useState("");

  useEffect(() => {
    setWattPerPduDraft(String(settings.wattPerPdu));
  }, [settings.wattPerPdu]);

  function setDevices(next: DeviceMaster[]): void {
    setSettings({ ...settings, devices: next });
  }

  function setInputMasters(next: InputMaster[]): void {
    setSettings({ ...settings, inputMasters: next });
  }

  function setTriggerMasters(next: TriggerMaster[]): void {
    setSettings({ ...settings, triggerMasters: next });
  }

  function setDisplayScale(next: number): void {
    setSettings({ ...settings, displayScale: next });
  }

  function setAdminMode(next: boolean): void {
    setSettings({
      ...settings,
      adminMode: next,
      cfsLinkedValueHighlightEnabled: next ? settings.cfsLinkedValueHighlightEnabled : false,
      cfsLinkMapEnabled: next ? settings.cfsLinkMapEnabled : false,
    });
  }

  function setCfsLinkedValueHighlight(next: boolean): void {
    setSettings({ ...settings, cfsLinkedValueHighlightEnabled: next });
  }

  function setCfsLinkMap(next: boolean): void {
    setSettings({ ...settings, cfsLinkMapEnabled: next });
  }

  function setWattPerPdu(next: number): void {
    const safeValue = Number.isFinite(next) && next > 0 ? next : 3;
    setSettings({ ...settings, wattPerPdu: safeValue });
  }

  function commitWattPerPdu(): void {
    const parsed = Number.parseFloat(wattPerPduDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setWattPerPduDraft(String(settings.wattPerPdu));
      return;
    }
    setWattPerPdu(parsed);
  }

  return (
    <div className={`app-settings-panel${embedded ? " app-settings-panel-embedded" : ""}`}>
      <header className="app-header fade-in">
        <h1 className="app-title" id={embedded ? "app-settings-overlay-title" : undefined}>
          Device Master
          <span className="app-title-meta">Shared App Settings</span>
        </h1>
        <p className="app-subtitle">
          Devices registered here are shared by every project.
        </p>
      </header>

      <div className="tabs-card fade-in" role="tablist" aria-label="Settings">
        <button
          type="button"
          className={`tab${activeTab === "devices" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("devices")}
        >
          Device Master
        </button>
        <button
          type="button"
          className={`tab${activeTab === "inputs" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("inputs")}
        >
          Input Master
        </button>
        <button
          type="button"
          className={`tab${activeTab === "triggers" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("triggers")}
        >
          Trigger Master
        </button>
        <button
          type="button"
          className={`tab${activeTab === "display" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("display")}
        >
          Display
        </button>
      </div>

      {activeTab === "devices" ? (
        <>
          <section className="card card-padded fade-in pdu-settings-card">
            <div className="toolbar">
              <h2 className="screen-section-title">PDU Settings</h2>
            </div>
            <div className="pdu-settings-grid">
              <label className="pdu-settings-field">
                <span>VA / PDU</span>
                <input
                  className="cell-input"
                  type="text"
                  inputMode="decimal"
                  value={wattPerPduDraft}
                  onChange={(event) => setWattPerPduDraft(event.target.value)}
                  onBlur={commitWattPerPdu}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
            </div>
          </section>
          <DevicesView devices={settings.devices} onChange={setDevices} />
        </>
      ) : activeTab === "inputs" ? (
        <InputMastersView
          inputMasters={settings.inputMasters}
          onChange={setInputMasters}
        />
      ) : activeTab === "triggers" ? (
        <TriggerMastersView
          triggerMasters={settings.triggerMasters}
          onChange={setTriggerMasters}
        />
      ) : (
        <DisplaySettingsView
          displayScale={settings.displayScale}
          adminMode={settings.adminMode}
          cfsLinkedValueHighlightEnabled={settings.cfsLinkedValueHighlightEnabled}
          cfsLinkMapEnabled={settings.cfsLinkMapEnabled}
          onChange={setDisplayScale}
          onAdminModeChange={setAdminMode}
          onCfsLinkedValueHighlightChange={setCfsLinkedValueHighlight}
          onCfsLinkMapChange={setCfsLinkMap}
        />
      )}
    </div>
  );
}
