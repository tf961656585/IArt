import React from "react";
import ReactDOM from "react-dom/client";
import "@/app/globals.css";
import EditorAppProviders from "@/components/providers/EditorAppProviders";
import AppShell from "@/features/layout/AppShell";
import EditorDesktopEntryClient from "@/features/pages/EditorDesktopEntryClient";
import { initCliProxyReceiver } from "@/features/canvas/services/cliProxyReceiver";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { installRuntimeErrorReporter } from "@/client/utils/runtimeErrorReporter";
import { readStoredThemeMode } from "@/client/store/appStore";
import { applyThemeMode } from "@/client/styles/theme";

const container = document.getElementById("root");

if (!container) {
  throw new Error("editor desktop renderer root container missing");
}

installRuntimeErrorReporter();

// CLI 代理执行通道接收器（spec docs/integrations/CLI与本地Agent集成.md §6.3）：
// 画布窗口启动即订阅主进程命令请求（desktop-main 是画布窗口唯一 CSR 入口，天然只订阅一次）；
// 非桌面宿主（无 electron 桥）在接收器内部留痕跳过。命令映射为既有编辑 action 执行，
// 串行队列与响应回传都在接收器模块内完成，不随 React 挂载/卸载反复建立。
initCliProxyReceiver();

// 持久化主题在 React 渲染前同步落到 documentElement（对齐 hub-entry 模式），
// 避免深色用户首帧按浅色默认值绘制造成闪屏；AppThemeProvider 挂载后接管后续切换。
applyThemeMode(readStoredThemeMode());

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <EditorAppProviders initialLocale={DEFAULT_LOCALE}>
      <AppShell>
        <EditorDesktopEntryClient />
      </AppShell>
    </EditorAppProviders>
  </React.StrictMode>,
);
