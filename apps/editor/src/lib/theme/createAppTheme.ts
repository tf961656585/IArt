/**
 * 基于 shadcn + Tailwind 的主题导出（替代 MUI）。
 *
 * 变更说明：
 * - 移除对 `@mui/*` 的所有依赖，不再返回 MUI Theme 对象。
 * - 与 `src/app/globals.css` 中的 CSS 变量保持一致，通过 data-theme/class="dark" 控制明暗。
 * - 为兼容历史命名，保留 `getAppTheme` 导出，但其语义为“返回主题令牌”。
 */

import type { AppThemeMode, ThemeTokens } from "@/client/styles/theme";
import { getThemeTokens } from "@/client/styles/theme";

export type { AppThemeMode, ThemeTokens };

/**
 * 返回可用于拼接 Tailwind 类或内联样式的令牌。
 * 示例：
 *   const t = getAppTheme('light');
 *   <button className={cn(t.typography.body, t.components.buttonBase)} />
 */
export const getAppTheme = (mode: AppThemeMode): ThemeTokens => getThemeTokens(mode);

/**
 * 可选：提供一组最小的“调色板”别名，帮助从 MUI 迁移中的调用点过渡。
 * 不依赖任何 MUI 类型，仅作语义映射。
 */
export const getPalette = (mode: AppThemeMode) => {
  const t = getThemeTokens(mode);
  return {
    mode,
    primary: { main: t.color.brand },
    text: { primary: t.color.fg, secondary: t.color.fgMuted },
    background: { default: t.color.bg, paper: t.color.bgAlt },
    border: t.color.border,
  } as const;
};
