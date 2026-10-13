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

  // 同步 data-theme，用于自定义样式读取；同步主进程 nativeTheme，
  // 让原生标题栏/菜单/对话框跟随应用主题（原生 chrome 不读 renderer 状态）
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", effectiveMode);
    }
    const api = window.electron;
    if (typeof api?.setNativeThemeSource === "function") {
      void api.setNativeThemeSource(effectiveMode);
    }
  }, [effectiveMode]);

  return (
    <NextThemesProvider attribute="class" forcedTheme={effectiveMode} defaultTheme="light" enableSystem>
      {children}
    </NextThemesProvider>
  );
};

export default AppThemeProvider;
