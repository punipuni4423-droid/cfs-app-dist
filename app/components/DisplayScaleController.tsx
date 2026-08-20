"use client";

import { useEffect } from "react";
import { useAppSettings } from "../lib/appSettings";

export default function DisplayScaleController() {
  const { settings } = useAppSettings();

  useEffect(() => {
    const scale = Math.min(1.5, Math.max(0.5, settings.displayScale || 1));
    document.documentElement.style.setProperty("--app-content-scale", String(scale));
    return () => {
      document.documentElement.style.removeProperty("--app-content-scale");
    };
  }, [settings.displayScale]);

  return null;
}
