/**
 * Hub 主题切换时同步 Windows 窗口 overlay 配色。
 *
 * macOS 交通灯由系统渲染，不参与同步；仅 win32 执行，避免无效 IPC。
 * 配色映射自 Hub 视觉令牌 --background / --foreground（spec docs/hub/window-chrome.md §7.2）。
 *
 * 调用时机：applyThemeToDocument toggle .dark class 之后（此时 getComputedStyle 读到的是新主题计算值）。
 * 在 React 树外（hub-entry bootstrap 前）执行，故直接消费全局 window.electron，不经 hubPlatformBridge。
 */

export function syncTitleBarOverlay(): void {
  const api = window.electron;
  // 仅 Windows 有 titleBarOverlay；macOS/其他平台跳过（overlay 在 mac 是 no-op）。
  if (!api || api.platform !== 'win32' || typeof api.setTitleBarOverlay !== 'function') return;
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue('--background').trim();
  const foreground = styles.getPropertyValue('--foreground').trim();
  if (!background || !foreground) return;
  void api.setTitleBarOverlay(background, foreground);
}
