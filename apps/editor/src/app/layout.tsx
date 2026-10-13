import type { Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { initAutoDiscovery } from "@/client/config/models.config";
import { runStartupValidation } from "@/client/config/modelValidator";
import EditorAppProviders from "@/components/providers/EditorAppProviders";

// Next.js 14 起，themeColor 需移至 viewport 导出
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f10" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  await initAutoDiscovery();
  runStartupValidation();
  return (
    <html lang={DEFAULT_LOCALE} suppressHydrationWarning translate="no" className="notranslate">
      <body data-locale={DEFAULT_LOCALE} className="notranslate">
        <EditorAppProviders initialLocale={DEFAULT_LOCALE}>{children}</EditorAppProviders>
      </body>
    </html>
  );
}
