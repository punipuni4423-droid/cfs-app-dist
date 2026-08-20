import type { Metadata } from "next";
import "./globals.css";
import SettingsMenu from "./components/SettingsMenu";
import DisplayScaleController from "./components/DisplayScaleController";

const cfsIconVersion = "20260817-hy08";

export const metadata: Metadata = {
  title: "CFS - Lighting Circuit Sheet",
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
        <DisplayScaleController />
        <SettingsMenu />
        {children}
      </body>
    </html>
  );
}
