/**
 * 应用生效主题同步到主进程 nativeTheme.themeSource。
 *
 * 原生窗口 chrome（Editor 原生标题栏、原生菜单、对话框、滚动条）只认主进程外观，
 * 不读 renderer 主题 class / localStorage；不同步时这些表面永远跟随系统外观
 * （深色主题下呈现浅色标题栏）。与 syncTitleBarOverlay 互补：
 * overlay 是 Windows Hub 无边框标题栏的显式配色，本函数覆盖全平台原生表面。
 *
 * 调用时机：applyThemeToDocument 解析出生效主题后（与 DOM class 同步）。
 * 在 React 树外（hub-entry bootstrap 前）执行，故直接消费全局 window.electron。
 */

export function syncNativeThemeSource(effective: 'light' | 'dark'): void {
  const api = window.electron;
  if (!api || typeof api.setNativeThemeSource !== 'function') return;
  void api.setNativeThemeSource(effective);
}
