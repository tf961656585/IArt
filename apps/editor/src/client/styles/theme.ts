/**
 * 使用 Shadcn + Tailwind 的轻量主题令牌。
 *
 * 说明：
 * - 不再依赖 MUI 的 createTheme / ThemeProvider。
 * - 与 `src/app/globals.css` 定义的 CSS 变量保持一致，通过
 *   documentElement 的 `data-theme` 与 `class="dark"` 切换明暗模式。
 * - 下方导出的令牌可在需要的地方进行样式拼接（如 cn() + Tailwind 类）。
 */

export type AppThemeMode = 'light' | 'dark';

export type ThemeTokens = {
  color: {
    brand: string;
    brandAccent: string;
    bg: string;
    bgAlt: string;
    fg: string;
    fgMuted: string;
    border: string;
    danger: string;
    warning: string;
    success: string;
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
  };
  shadow: {
    sm: string;
    md: string;
    lg: string;
  };
  transition: {
    fast: string;
    base: string;
  };
  typography: {
    fontFamily: string;
    h1: string; // Tailwind 类
    h2: string;
    h3: string;
    body: string;
  };
  components: {
    buttonBase: string; // Tailwind 类集合
  };
};

/**
 * 返回一组与 CSS 变量对齐的主题令牌。
 * 注意：颜色等值通过 CSS 变量在运行时解析，此处仅返回变量引用。
 */
export const getThemeTokens = (_mode: AppThemeMode): ThemeTokens => ({
  color: {
    brand: 'var(--color-brand)',
    brandAccent: 'var(--color-brand-accent)',
    bg: 'var(--color-bg)',
    bgAlt: 'var(--color-bg-alt)',
    fg: 'var(--color-fg)',
    fgMuted: 'var(--color-fg-muted)',
    border: 'var(--color-border)',
    danger: 'var(--color-danger)',
    warning: 'var(--color-warning)',
    success: 'var(--color-success)'
  },
  radius: {
    sm: 'var(--radius-sm)',
    md: 'var(--radius-md)',
    lg: 'var(--radius-lg)'
  },
  shadow: {
    sm: 'var(--shadow-sm)',
    md: 'var(--shadow-md)',
    lg: 'var(--shadow-lg)'
  },
  transition: {
    fast: 'var(--transition-fast)',
    base: 'var(--transition-base)'
  },
  typography: {
    fontFamily: 'var(--font-sans)',
    // 结合 Tailwind 原子类，保持与原先设计规模接近
    h1: 'text-3xl font-semibold',
    h2: 'text-2xl font-semibold',
    h3: 'text-xl font-semibold',
    body: 'text-base leading-relaxed'
  },
  components: {
    // 对应原先 MUI Button 的几个风格点：圆角、阴影、过渡
    buttonBase:
      'inline-flex items-center gap-2 rounded-[var(--radius-md)] ' +
      'shadow-[var(--shadow-sm)] transition-[box-shadow,transform,background] ' +
      'px-4 py-2 font-medium hover:shadow-[var(--shadow-md)]'
  }
});

/**
 * 可选：辅助函数，运行时同步 data-theme（若未使用 AppThemeProvider）。
 */
export function applyThemeMode(mode: AppThemeMode) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}
