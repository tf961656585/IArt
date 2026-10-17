/**
 * 把主题偏好直写到主进程 nativeTheme.themeSource。
 *
 * 原生窗口 chrome（Editor 原生标题栏、原生菜单、对话框、滚动条）只认主进程外观，
 * 不读 renderer 主题 class / localStorage；不同步时这些表面永远跟随系统外观。
 *
 * 裁定（docs/hub/window-chrome.md §7.5）：themeSource 是 app 级单值、由 Hub 偏好
 * 唯一驱动（Editor 不写，见 docs/editor/window-chrome.md）。system 必须直写
 * 'system'——themeSource 会反向覆盖渲染端 prefers-color-scheme 媒询，把 system
 * 解析成 light/dark 再推送会让媒询从此只读到被写死的值，「跟随系统」自锁失效
 * （2026-10-16 实证）。
 *
 * 调用时机：applyThemeToDocument 应用偏好时（与 DOM class 同步）。
 * 在 React 树外（hub-entry bootstrap 前）执行，故直接消费全局 window.electron。
 */

import type { ThemePreference } from './theme-store';

export function syncNativeThemeSource(pref: ThemePreference): void {
  const api = window.electron;
  if (!api || typeof api.setNativeThemeSource !== 'function') return;
  void api.setNativeThemeSource(pref);
}
