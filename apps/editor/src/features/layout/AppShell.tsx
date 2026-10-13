"use client";

import type { PropsWithChildren } from "react";
import { useState, useEffect } from "react";
import { useRuntimeStore } from "@/client/store/runtimeStore";
import useBootstrapClient from "@/features/hooks/useBootstrapClient";
import { Toaster } from "@/components/ui/sonner";
import { OverlayEscapeDispatcher } from "@iart/ui";
import AnnouncementBanner from "@/client/components/AnnouncementBanner";
import { isHubRuntime } from "@/client/utils/hubFetch";
import { fetchAppVersionFromElectron } from "@/client/utils/electronBridge";
import { setRuntimeAppVersion } from "@/client/utils/appVersion";
import DiagnosticErrorBoundary from "@/components/system/DiagnosticErrorBoundary";
import packageJson from "../../../package.json";

const getBootstrapDisplayError = (message: string | null): string => {
  if (!message) return "项目打开失败，请重新打开项目。";
  if (
    message.includes("Desktop Shell") ||
    message.includes("editor bootstrap")
  ) {
    return "项目打开失败，请重新打开项目。";
  }
  return message;
};

const AppShell: React.FC<PropsWithChildren> = ({ children }) => {
  useBootstrapClient();
  const setAppVersionInStore = useRuntimeStore((state) => state.setAppVersion);
  const bootstrapStatus = useRuntimeStore((state) => state.bootstrapStatus);
  const bootstrapError = useRuntimeStore((state) => state.bootstrapError);
  const [appVersion, setAppVersion] = useState<string>(() => {
    const envVersion =
      typeof process !== "undefined"
        ? process.env["NEXT_PUBLIC_APP_VERSION"]
        : undefined;
    if (typeof envVersion === "string" && envVersion.trim()) {
      return envVersion.trim();
    }
    const pkgVersion =
      typeof (packageJson !== null && packageJson !== undefined ? packageJson.version : undefined) === "string"
        ? packageJson.version.trim()
        : "";
    return pkgVersion || "dev";
  });

  useEffect(() => {
    setRuntimeAppVersion(appVersion);
    setAppVersionInStore(appVersion);
  }, [appVersion, setAppVersionInStore]);

  useEffect(() => {
    let cancelled = false;
    const syncAppVersion = async () => {
      const version = await fetchAppVersionFromElectron();
      if (!cancelled && version) {
        setAppVersion(version);
      }
    };
    void syncAppVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  const shouldBlockForDesktopBootstrap =
    typeof window !== "undefined" && Boolean(window.electron);
  const shouldEnableDiagnosticBoundary = shouldBlockForDesktopBootstrap;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 每窗口唯一的 Esc 分发器（spec docs/editor/浮层堆栈管理.md 核心规则 1）：挂在 React 根部，
          不渲染 DOM。浮层经 useOverlayLayer 注册，Esc 只派发栈顶。 */}
      <OverlayEscapeDispatcher />
      <Toaster />
      <div className="shrink-0">
        {!isHubRuntime() ? <AnnouncementBanner /> : null}
      </div>

      <div className="relative flex flex-1 min-h-0 w-full">
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-hidden max-w-full flex flex-col">
            {shouldBlockForDesktopBootstrap && bootstrapStatus !== "ready" ? (
              <div className="flex h-full items-center justify-center px-6 py-8">
                <div className="max-w-xl rounded-2xl border border-border/60 bg-background/95 p-6 shadow-sm">
                  <h1 className="text-lg font-semibold text-foreground">
                    {bootstrapStatus === "error"
                      ? "项目打开失败"
                      : "正在打开项目"}
                  </h1>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {bootstrapStatus === "error"
                      ? getBootstrapDisplayError(bootstrapError)
                      : "正在打开项目，请稍候。"}
                  </p>
                </div>
              </div>
            ) : shouldEnableDiagnosticBoundary ? (
              <DiagnosticErrorBoundary label="AppShell">
                {children}
              </DiagnosticErrorBoundary>
            ) : (
              children
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default AppShell;
