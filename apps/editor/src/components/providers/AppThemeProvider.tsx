"use client";

import type { PropsWithChildren } from "react";
import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useAppStore } from "@/client/store/appStore";

type AppThemeProviderProps = PropsWithChildren<Partial<{
  mode: "light" | "dark" | undefined;
}>>;

const AppThemeProvider: React.FC<AppThemeProviderProps> = ({ children, mode }) => {
  const storeMode = useAppStore((state) => state.themeMode);
  const effectiveMode = mode ?? storeMode ?? "light";

  // 同步 data-theme，用于自定义样式读取。
  // 原生主题开关（nativeTheme.themeSource）由 Hub 偏好唯一驱动，Editor 不写——
  // 它是 app 级单值且会反向覆盖渲染端 prefers-color-scheme 媒询，多写者会互相污染
  // （docs/hub/window-chrome.md §7.5、docs/editor/window-chrome.md）。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", effectiveMode);
    }
  }, [effectiveMode]);

  return (
    <NextThemesProvider attribute="class" forcedTheme={effectiveMode} defaultTheme="light" enableSystem>
      {children}
    </NextThemesProvider>
  );
};

export default AppThemeProvider;
