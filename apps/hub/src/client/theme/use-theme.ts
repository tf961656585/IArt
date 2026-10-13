import { useCallback, useEffect, useState } from 'react';
import {
  applyThemeToDocument,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from './theme-store';

/**
 * 主题偏好 hook：读写 localStorage + 应用到 DOM + 响应系统主题变化。
 *
 * 切换机制见 docs/hub/hub-renderer-architecture.md §8.1。
 * bootstrap 阶段的首次应用由 hub-entry.tsx 同步完成（避免首屏闪屏），
 * 本 hook 在 React 挂载后接管：用 localStorage 初始化状态、偏好变化时
 * 持久化并应用、system 模式下监听 prefers-color-scheme 变化实时重应用。
 */
export function useTheme(): {
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);

  // 偏好变化：持久化 + 应用到 DOM
  useEffect(() => {
    writeThemePreference(preference);
    applyThemeToDocument(preference);
  }, [preference]);

  // system 模式下监听系统主题变化，实时重新应用；偏好非 system 时无监听
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeToDocument('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
  }, []);

  return { preference, setPreference };
}
