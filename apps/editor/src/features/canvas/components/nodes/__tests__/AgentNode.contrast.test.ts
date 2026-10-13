import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Agent 容器视觉令牌对比度回归（docs/editor/visual-design.md §5.10 / §10 验收 6；CN-V-09）。
 *
 * 读 `globals.css` 令牌真值 × 组件实际混色公式复算断言，不复制色值（先例：
 * AgentToolProposalPanel.test.tsx「临界档进度条对比度」）：
 * - tint 背景上的正文 ≥4.5:1（6% 常态底 / 4% 嵌套底 / 12% 选中·chip 底，双主题）；
 * - 身份色 `--agent-accent` 作描边等非文本指示 ≥3:1（浅色白底 / 深色画布底）；
 * - 计数徽章文字 `--agent-accent-text`（浅 700 档 / 深 300 档）on 10%×card 徽章底 ≥4.5:1；
 * - LOD 锚点文字 `--group-anchor-text` on 身份色实底 ≥3:1
 *   （500 档组色实底压白字不达标的先例勿重犯：锚点走固定近黑字，本用例钉住其达标）；
 * - `--muted-foreground` 白底 4.73:1 余量薄：断言先行钉住，不达标改值不改断言。
 */

type Rgb = { r: number; g: number; b: number };

const readCss = (): string =>
  readFileSync(join(process.cwd(), 'apps/editor/src/app/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

/**
 * 三个令牌块：`:root`（浅色）/ `[data-theme='dark']`（项目语义令牌，含 --st-*、--agent-*）/
 * `.dark`（shadcn 中性令牌，含 --card、--foreground 深档）。两轨主题由 AppThemeProvider 同时写入。
 */
const readCssTokenBlocks = (): {
  light: Record<string, string>;
  dark: Record<string, string>;
  darkSurface: Record<string, string>;
} => {
  const css = readCss();
  const blockOf = (selector: string): Record<string, string> => {
    const start = css.indexOf(selector);
    if (start === -1) throw new Error(`globals.css 缺少 ${selector}`);
    const open = css.indexOf('{', start);
    const end = css.indexOf('}', open);
    const body = css.slice(open + 1, end);
    const tokens: Record<string, string> = {};
    for (const match of body.matchAll(/--([A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const name = match[1];
      const value = match[2];
      if (name !== undefined && value !== undefined) tokens[name] = value.trim();
    }
    return tokens;
  };
  return {
    light: blockOf(':root {'),
    dark: blockOf("[data-theme='dark'] {"),
    darkSurface: blockOf('.dark {'),
  };
};

/** 解析用到的色值写法：`#rrggbb` 与 `oklch(L C H)`（令牌均为无彩度中性档或锚定 hex）。 */
const parseColor = (value: string): Rgb => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex !== null && hex[1] !== undefined) {
    const int = Number.parseInt(hex[1], 16);
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (oklch === null) throw new Error(`未支持的色值写法：${value}`);
  const [l, c, h] = [Number(oklch[1]), Number(oklch[2]), Number(oklch[3])];
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const lCubed = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCubed = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCubed = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (linear: number): number =>
    Math.round(
      Math.min(
        1,
        Math.max(0, linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055),
      ) * 255,
    );
  return {
    r: encode(4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed),
    g: encode(-1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed),
    b: encode(-0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed),
  };
};

/**
 * `color-mix(in srgb, A weight%, B)` 不透明混色：sRGB 逐通道线性插值后取整。
 * 组件里的 `color-mix(in srgb, A w%, transparent)` 叠在底色 base 上等价于 A 权重 w、base 权重 1-w。
 */
const mix = (a: Rgb, b: Rgb, weightA: number): Rgb => ({
  r: Math.round(a.r * weightA + b.r * (1 - weightA)),
  g: Math.round(a.g * weightA + b.g * (1 - weightA)),
  b: Math.round(a.b * weightA + b.b * (1 - weightA)),
});

const relativeLuminance = ({ r, g, b }: Rgb): number => {
  const channel = (raw: number): number => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

/** `--agent-surface-nested` 真值公式解析：color-mix(in srgb, var(--agent-accent) W%, transparent)。 */
const readNestedFormula = (): { weight: number; source: string } => {
  const css = readCss();
  const match = /--agent-surface-nested:\s*([^;]+);/.exec(css);
  if (match === null || match[1] === undefined) {
    throw new Error('globals.css 缺少 --agent-surface-nested');
  }
  const value = match[1].trim();
  const formula = /^color-mix\(\s*in srgb\s*,\s*var\(--agent-accent\)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(
    value,
  );
  if (formula === null || formula[1] === undefined) {
    throw new Error(`--agent-surface-nested 不是身份色 color-mix 公式：${value}`);
  }
  return { weight: Number(formula[1]), source: value };
};

const readAnchorText = (): Rgb => {
  // --group-anchor-text 随行数门禁腾挪下沉到 containerNodes.css（组件级样式）；
  // 两个定义点任一命中即读真值，注释已剥离不误匹配。
  const sources = [readCss(), readFileSync(join(process.cwd(), 'apps/editor/src/features/canvas/components/nodes/containerNodes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')];
  for (const source of sources) {
    const match = /--group-anchor-text:\s*([^;]+);/.exec(source);
    if (match !== null && match[1] !== undefined) return parseColor(match[1]);
  }
  throw new Error('globals.css 与 containerNodes.css 均缺少 --group-anchor-text');
};

describe('Agent 容器对比度底线（CN-V-09）', () => {
  // @spec: AG-CT-005
  it('身份色非文本 ≥3:1：--agent-accent on 浅色白底 / 深色画布底', () => {
    const { light, dark } = readCssTokenBlocks();
    const accentLight = parseColor(light['agent-accent'] ?? '');
    const accentDark = parseColor(dark['agent-accent'] ?? '');
    const canvasLight = parseColor(light['color-bg'] ?? '');
    const canvasDark = parseColor(dark['color-bg'] ?? '');

    expect(contrastRatio(accentLight, canvasLight)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(accentDark, canvasDark)).toBeGreaterThanOrEqual(3);
  });

  // @spec: AG-CT-005
  it('tint 背景上的正文 ≥4.5:1：6% 常态 / 4% 嵌套 / 12% 选中档，双主题', () => {
    const { light, dark, darkSurface } = readCssTokenBlocks();
    const accentLight = parseColor(light['agent-accent'] ?? '');
    const accentDark = parseColor(dark['agent-accent'] ?? '');
    const canvasLight = parseColor(light['color-bg'] ?? '');
    const canvasDark = parseColor(dark['color-bg'] ?? '');
    const fgLight = parseColor(light['foreground'] ?? '');
    const fgDark = parseColor(darkSurface['foreground'] ?? '');

    for (const weight of [0.06, 0.04, 0.12]) {
      const bgLight = mix(accentLight, canvasLight, weight);
      const bgDark = mix(accentDark, canvasDark, weight);
      expect(contrastRatio(fgLight, bgLight)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(fgDark, bgDark)).toBeGreaterThanOrEqual(4.5);
    }
  });

  // @spec: AG-CT-005
  it('chip / 折叠卡文字 ≥4.5:1：12%×card 底上的正文，双主题', () => {
    const { light, dark, darkSurface } = readCssTokenBlocks();
    const accentLight = parseColor(light['agent-accent'] ?? '');
    const accentDark = parseColor(dark['agent-accent'] ?? '');
    const cardLight = parseColor(light['card'] ?? '');
    const cardDark = parseColor(darkSurface['card'] ?? '');
    const fgLight = parseColor(light['foreground'] ?? '');
    const fgDark = parseColor(darkSurface['foreground'] ?? '');

    const chipBgLight = mix(accentLight, cardLight, 0.12);
    const chipBgDark = mix(accentDark, cardDark, 0.12);
    expect(contrastRatio(fgLight, chipBgLight)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fgDark, chipBgDark)).toBeGreaterThanOrEqual(4.5);
  });

  // @spec: AG-CT-005
  it('计数徽章文字 ≥4.5:1：--agent-accent-text（浅 700 / 深 300 档）on 10%×card 底', () => {
    const { light, dark, darkSurface } = readCssTokenBlocks();
    const accentLight = parseColor(light['agent-accent'] ?? '');
    const accentDark = parseColor(dark['agent-accent'] ?? '');
    const textLight = parseColor(light['agent-accent-text'] ?? '');
    const textDark = parseColor(dark['agent-accent-text'] ?? '');
    const cardLight = parseColor(light['card'] ?? '');
    const cardDark = parseColor(darkSurface['card'] ?? '');

    const badgeBgLight = mix(accentLight, cardLight, 0.1);
    const badgeBgDark = mix(accentDark, cardDark, 0.1);
    expect(contrastRatio(textLight, badgeBgLight)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(textDark, badgeBgDark)).toBeGreaterThanOrEqual(4.5);
  });

  // @spec: AG-CT-005
  it('LOD 锚点文字 ≥3:1：--group-anchor-text on --agent-accent 实底，双主题', () => {
    const { light, dark } = readCssTokenBlocks();
    const anchor = readAnchorText();
    const accentLight = parseColor(light['agent-accent'] ?? '');
    const accentDark = parseColor(dark['agent-accent'] ?? '');

    expect(contrastRatio(anchor, accentLight)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(anchor, accentDark)).toBeGreaterThanOrEqual(3);
  });

  // @spec: AG-CT-005
  it('--muted-foreground 白底 ≥4.5:1（4.73:1 余量薄，测试先行钉住：不达标改值不改断言）', () => {
    const { light } = readCssTokenBlocks();
    const muted = parseColor(light['muted-foreground'] ?? '');
    const background = parseColor(light['background'] ?? '');
    expect(contrastRatio(muted, background)).toBeGreaterThanOrEqual(4.5);
  });

  // @spec: AG-CT-005
  it('--agent-surface-nested 真值 = 身份色 4% color-mix（嵌套底档公式与令牌耦合）', () => {
    const { weight } = readNestedFormula();
    expect(weight).toBe(4);
  });
});
