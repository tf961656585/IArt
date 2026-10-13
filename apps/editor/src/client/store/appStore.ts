import { createWithEqualityFn } from 'zustand/traditional';

type ThemeMode = 'light' | 'dark';

interface AppState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  sidebarCollapsed: boolean;          // 桌面端折叠
  sidebarMobileOpen: boolean;         // 移动端打开状态
  toggleSidebar: () => void;          // 通用切换：移动端开关 / 桌面端折叠
  mediaCacheMaxSize: number;
  mediaCacheTTL: number;
  setMediaCacheMaxSize: (size: number) => void;
  setMediaCacheTTL: (ttl: number) => void;
}

// 主题持久化（与 hub:theme 同裁定：localStorage 同步读，不进 backend config——
// 主题必须在 React 渲染前同步应用以避免首屏闪屏）。app 级设置，与项目无关。
const THEME_MODE_STORAGE_KEY = 'iarts.editor.themeMode';

/** 读取持久化的主题；非法值或读取失败回退浅色。desktop-main 首帧前也经此应用。 */
export function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'light';
  } catch {
    return 'light';
  }
}

const writeStoredThemeMode = (mode: ThemeMode): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时静默降级（内存仍可切换，仅不持久化）
  }
};

export const useAppStore = createWithEqualityFn<AppState>()((set, get) => ({
  themeMode: readStoredThemeMode(),
  setThemeMode: (mode) => {
    writeStoredThemeMode(mode);
    set({ themeMode: mode });
  },
  sidebarCollapsed: true,
  sidebarMobileOpen: false,
  toggleSidebar: () => {
    // 根据屏幕宽度决定行为：运行时无法直接取窗口宽度（SSR）这里简单依赖 window 判定
    if (typeof window !== 'undefined' && window.innerWidth < 900) {
      set({ sidebarMobileOpen: !get().sidebarMobileOpen });
    } else {
      set({ sidebarCollapsed: !get().sidebarCollapsed });
    }
  },
  mediaCacheMaxSize: 1024 * 1024 * 1024,
  mediaCacheTTL: 30 * 24 * 60 * 60 * 1000,
  setMediaCacheMaxSize: (size) => set({ mediaCacheMaxSize: size }),
  setMediaCacheTTL: (ttl) => set({ mediaCacheTTL: ttl })
}));
