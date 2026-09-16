"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AppBuildVersion } from "../lib/appBuildVersion";

const AppBuildInfoContext = createContext<AppBuildVersion | null>(null);

interface AppBuildInfoProviderProps {
  info: AppBuildVersion | null;
  children: ReactNode;
}

/** Carries the server-read build metadata to client components without an API call. */
export default function AppBuildInfoProvider({ info, children }: AppBuildInfoProviderProps) {
  return <AppBuildInfoContext.Provider value={info}>{children}</AppBuildInfoContext.Provider>;
}

export function useAppBuildInfo(): AppBuildVersion | null {
  return useContext(AppBuildInfoContext);
}
