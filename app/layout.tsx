import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
import SettingsMenu from "./components/SettingsMenu";
import DisplayScaleController from "./components/DisplayScaleController";
import MigrationNotice from "./components/MigrationNotice";
import ApiAccessGate from "./components/ApiAccessGate";
import AppBuildInfoProvider from "./components/AppBuildInfoProvider";
import { readRunningBuildInfo } from "./lib/appBuildInfoServer";

const cfsIconVersion = "20260817-hy08";

export const metadata: Metadata = {
  title: "CFS - Control Function Sheet",
  description: "GRMS / CFS sheet editor with Excel export",
  icons: {
    icon: `/cfs-app-icon.ico?v=${cfsIconVersion}`,
    shortcut: `/cfs-app-icon.ico?v=${cfsIconVersion}`,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read per request so the "App version" badge always reflects the build
  // metadata next to the app folder (same source as the Update status API).
  // connection() opts the render out of build-time prerendering: the metadata
  // file is written after "next build", so a static snapshot would show the
  // previous build's SHA.
  await connection();
  const buildInfo = await readRunningBuildInfo();
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-screen flex flex-col">
        <ApiAccessGate>
        <AppBuildInfoProvider info={buildInfo}>
        <DisplayScaleController />
        <SettingsMenu />
        <MigrationNotice />
        {children}
        </AppBuildInfoProvider>
        </ApiAccessGate>
      </body>
    </html>
  );
}
