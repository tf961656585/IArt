/**
 * Hub 主题偏好存储与应用。
 *
 * 切换机制规范见 docs/hub/hub-renderer-architecture.md §8.1。
 * 视觉令牌与对比度约束见 docs/hub/visual-design.md §5.4 / §5.5。
 * 窗口 chrome 主题同步（Windows overlay）见 docs/hub/window-chrome.md §7。
 *
 * read/write/resolve 为纯函数；applyThemeToDocument 含 DOM 副作用（toggle .dark class）
 * 与窗口 chrome 同步副作用（经 IPC 更新 Windows overlay 配色），无 React 依赖。
 *
 * 持久化用 localStorage（独立 themeStore），不进 backend config——
 * 主题必须在 React 渲染前同步应用以避免首屏闪屏，backend config 在
 * bootstrap 异步阶段才能获取，无法满足同步要求（spec §8.1 持久化裁定）。
 */

import { syncTitleBarOverlay } from './sync-title-bar-overlay';
import { syncNativeThemeSource } from './sync-native-theme';

/** 用户可选的主题偏好（user-facing）。 */
export type ThemePreference = 'light' | 'dark' | 'system';

/** 实际生效的主题（system 解析后，映射到 DOM class）。 */
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'hub:theme';
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** 读取持久化的主题偏好；非法值或读取失败回退默认（深色）。 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** 写入主题偏好到 localStorage；写入失败静默降级（内存仍可切换，仅不持久化）。 */
export function writeThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // localStorage 不可用时静默降级
  }
}

/** 解析偏好为实际生效主题；system 时读 prefers-color-scheme media query。 */
export function resolveEffectiveTheme(pref: ThemePreference): EffectiveTheme {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

/**
 * 将有效主题应用到 document 根元素（toggle .dark class）。
 * 幂等：重复应用同一偏好无副作用。返回生效主题供调用方使用。
 */
export function applyThemeToDocument(pref: ThemePreference): EffectiveTheme {
  const effective = resolveEffectiveTheme(pref);
  document.documentElement.classList.toggle('dark', effective === 'dark');
  syncTitleBarOverlay();
  syncNativeThemeSource(effective);
  return effective;
}
