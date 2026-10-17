/**
 * window chrome 主题同步 IPC handler（spec docs/hub/window-chrome.md §7.4/§7.5）。
 *
 * 从 registerDesktopIpcHandlers 拆出的可注入单元：electron 表面（nativeTheme、
 * 主窗口）由注入提供，handler 逻辑可不经 electron mock 直接测试。
 * 两个通道都只作用于 Hub 主窗口：显式取 getMainWindow()，不用 fromWebContents，
 * 防误广播到 Editor 窗口（spec §7.4）。
 *
 * 留痕：payload 解析失败与 themeSource 变更写主进程日志（logs/main.log）——
 * 解析失败静默吞掉正是 2026-10-16 oklch 白条缺陷长期不可见的形态，必须留痕。
 */

import {
  SetNativeThemeSourceRequestSchema,
  SetTitleBarOverlayRequestSchema,
  type SetTitleBarOverlayRequest,
} from "@iart/contracts";
import { appendMainLog } from "../main-log.cjs";

/** Windows titleBarOverlay 的最小窗口表面（BrowserWindow 的相关子集）。 */
type OverlayCapableWindow = {
  setTitleBarOverlay: (options: SetTitleBarOverlayRequest) => void;
  isDestroyed: () => boolean;
};

/** nativeTheme.themeSource 的最小表面（Electron NativeTheme 的相关子集）。 */
type NativeThemeSurface = { themeSource: "light" | "dark" | "system" };

/**
 * window:set-title-bar-overlay：renderer → main 同步 Windows overlay 配色。
 * 载荷必须是 sRGB hex（schema 拒绝 oklch——Electron 解析器静默回落白色）；
 * 解析失败留痕后忽略，不更新 overlay。
 */
export const createSetTitleBarOverlayHandler =
  (deps: { getMainWindow: () => OverlayCapableWindow | null | undefined }) =>
  (_event: unknown, payload: unknown): void => {
    const parsed = SetTitleBarOverlayRequestSchema.safeParse(payload);
    if (!parsed.success) {
      appendMainLog("debug", "window:set-title-bar-overlay payload 解析失败，忽略本次同步", payload);
      return;
    }
    const win = deps.getMainWindow();
    if (win !== null && win !== undefined && !win.isDestroyed()) {
      win.setTitleBarOverlay(parsed.data);
    }
  };

/**
 * window:set-native-theme-source：renderer → main 把主题偏好直写到 nativeTheme.themeSource。
 * themeSource 是 app 级单值、由 Hub 偏好唯一驱动（system 直写不解析，Editor 不写——
 * spec §7.5）；解析失败留痕后忽略，不改主进程外观。
 */
export const createSetNativeThemeSourceHandler =
  (deps: { nativeTheme: NativeThemeSurface }) =>
  (_event: unknown, payload: unknown): void => {
    const parsed = SetNativeThemeSourceRequestSchema.safeParse(payload);
    if (!parsed.success) {
      appendMainLog("debug", "window:set-native-theme-source payload 解析失败，忽略本次同步", payload);
      return;
    }
    deps.nativeTheme.themeSource = parsed.data.theme;
    appendMainLog("debug", "nativeTheme.themeSource 已更新", { theme: parsed.data.theme });
  };
