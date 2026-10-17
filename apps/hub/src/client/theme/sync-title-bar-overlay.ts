/**
 * Hub 主题切换时同步 Windows 窗口 overlay 配色。
 *
 * macOS 交通灯由系统渲染，不参与同步；仅 win32 执行，避免无效 IPC。
 * 配色映射自 Hub 视觉令牌 --background / --foreground（spec docs/hub/window-chrome.md §7.2）。
 * 令牌值是 oklch()，Electron 原生颜色解析器不认 oklch（静默回落白色白条），
 * 过 IPC 前必须经 @iart/utils 的 cssColorToHex 折算成 sRGB hex；折算失败跳过本次
 * 同步并留 debug 痕，绝不把折算不了的值送过原生边界（contracts schema 也会拒绝）。
 *
 * 调用时机：applyThemeToDocument toggle .dark class 之后（此时 getComputedStyle 读到的是新主题令牌）。
 * 在 React 树外（hub-entry bootstrap 前）执行，故直接消费全局 window.electron，不经 hubPlatformBridge。
 */

import { cssColorToHex } from '@iart/utils/css-color';

export function syncTitleBarOverlay(): void {
  const api = window.electron;
  // 仅 Windows 有 titleBarOverlay；macOS/其他平台跳过（overlay 在 mac 是 no-op）。
  if (!api || api.platform !== 'win32' || typeof api.setTitleBarOverlay !== 'function') return;
  const styles = getComputedStyle(document.documentElement);
  const backgroundRaw = styles.getPropertyValue('--background').trim();
  const foregroundRaw = styles.getPropertyValue('--foreground').trim();
  const background = cssColorToHex(backgroundRaw);
  const foreground = cssColorToHex(foregroundRaw);
  if (background === null || foreground === null) {
    console.debug('[theme] titleBarOverlay 令牌折算失败，跳过本次同步', {
      background: backgroundRaw,
      foreground: foregroundRaw,
    });
    return;
  }
  void api.setTitleBarOverlay(background, foreground);
}
