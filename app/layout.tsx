import type { Metadata } from "next";
import "./globals.css";
import SettingsMenu from "./components/SettingsMenu";
import DisplayScaleController from "./components/DisplayScaleController";
import MigrationNotice from "./components/MigrationNotice";
import ApiAccessGate from "./components/ApiAccessGate";

const cfsIconVersion = "20260817-hy08";

export const metadata: Metadata = {
  title: "CFS - Control Function Sheet",
  description: "GRMS / CFS sheet editor with Excel export",
  icons: {
    icon: `/cfs-app-icon.ico?v=${cfsIconVersion}`,
    shortcut: `/cfs-app-icon.ico?v=${cfsIconVersion}`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-screen flex flex-col">
        <ApiAccessGate>
        <DisplayScaleController />
        <SettingsMenu />
        <MigrationNotice />
        {children}
        </ApiAccessGate>
      </body>
    </html>
  );
}
