/**
 * CSS 颜色字符串 → sRGB hex 归一化（跨原生颜色边界的唯一折算点）。
 *
 * 背景：Electron 的原生 CSS 颜色解析器（ParseCSSColor，窗口 backgroundColor /
 * titleBarOverlay 等消费）只认 hex / rgb() / hsl() / named，oklch() 会静默解析
 * 失败回落白色（2026-10-16 实证）。应用视觉令牌统一用 oklch()（spec
 * docs/hub/visual-design.md §5.4），跨原生边界的颜色必须在边界折算成 hex——
 * 禁止在消费点手写第二套色值映射表。
 *
 * 转换算法：CSS Color 4 OKLCH → OKLab → 线性 sRGB → gamma 编码（W3C css-color-4
 * 示例实现常数）。金值以 Chromium 渲染像素（canvas getImageData，与 Electron 同源
 * 引擎）为准，两者逐字节一致，见 __tests__/css-color.test.ts。
 * 超出 sRGB 色域的分量按 0..1 钳制处理（应用令牌均为低彩度中性档，不触发）。
 */

/** gamma 编码前的线性 sRGB 三元组。 */
type LinearSrgb = readonly [number, number, number];
/** gamma 编码后的 sRGB 三元组（0..1）。 */
type SrgbUnit = readonly [number, number, number];

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// 现代空格语法与旧逗号语法都接受：rgb(13 14 20) / rgb(13, 14, 20) / rgba(... / 0.5)。
const RGB_PATTERN =
  /^rgba?\(\s*([0-9.]+%?)(?:\s+|,\s*)([0-9.]+%?)(?:\s+|,\s*)([0-9.]+%?)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i;
// L 与 alpha 支持百分比；C、H 只支持纯数字（应用令牌口径）。
const OKLCH_PATTERN =
  /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** gamma 编码：线性 sRGB → sRGB（0..1）。 */
const encodeSrgb = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;

/** OKLCH → 线性 sRGB（W3C css-color-4 示例实现常数）。 */
const oklchToLinearSrgb = (l: number, c: number, hDegrees: number): LinearSrgb => {
  const hRadians = (hDegrees * Math.PI) / 180;
  const a = c * Math.cos(hRadians);
  const b = c * Math.sin(hRadians);
  const lCubed = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCubed = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCubed = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed,
    -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed,
    -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed,
  ];
};

/** 解析数字或百分比（'50%' → 0.5 × percentBase）；非法返回 undefined。 */
const parseNumberOrPercent = (
  raw: string | undefined,
  percentBase: number,
): number | undefined => {
  if (raw === undefined) return undefined;
  if (raw.endsWith('%')) {
    const value = Number(raw.slice(0, -1));
    return Number.isFinite(value) ? (value / 100) * percentBase : undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const toHexByte = (unit: number): string =>
  Math.round(clamp01(unit) * 255)
    .toString(16)
    .padStart(2, '0');

const srgbUnitToHex = (srgb: SrgbUnit, alpha: number): string => {
  const alphaByte = Math.round(clamp01(alpha) * 255);
  const rgb = `${toHexByte(srgb[0])}${toHexByte(srgb[1])}${toHexByte(srgb[2])}`;
  return alphaByte >= 255 ? `#${rgb}` : `#${rgb}${alphaByte.toString(16).padStart(2, '0')}`;
};

const hexToNormalized = (raw: string): string | null => {
  const match = HEX_PATTERN.exec(raw);
  if (match === null || match[1] === undefined) return null;
  const digits = match[1].toLowerCase();
  if (digits.length === 3 || digits.length === 4) {
    return `#${digits
      .split('')
      .map((ch) => ch + ch)
      .join('')}`;
  }
  return `#${digits}`;
};

const oklchToHex = (raw: string): string | null => {
  const match = OKLCH_PATTERN.exec(raw);
  if (match === null) return null;
  const l = parseNumberOrPercent(match[1], 1);
  // 模式已保证 C、H 是纯数字（不带 %）。
  const c = Number(match[2]);
  const h = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : parseNumberOrPercent(match[4], 1);
  if (l === undefined || alpha === undefined || !Number.isFinite(c) || !Number.isFinite(h)) {
    return null;
  }
  const linear = oklchToLinearSrgb(l, c, h);
  return srgbUnitToHex(
    [encodeSrgb(linear[0]), encodeSrgb(linear[1]), encodeSrgb(linear[2])],
    alpha,
  );
};

const rgbToHex = (raw: string): string | null => {
  const match = RGB_PATTERN.exec(raw);
  if (match === null) return null;
  const r = parseNumberOrPercent(match[1], 255);
  const g = parseNumberOrPercent(match[2], 255);
  const b = parseNumberOrPercent(match[3], 255);
  const alpha = match[4] === undefined ? 1 : parseNumberOrPercent(match[4], 1);
  if (r === undefined || g === undefined || b === undefined || alpha === undefined) return null;
  return srgbUnitToHex([r / 255, g / 255, b / 255], alpha);
};

/**
 * 把 CSS 颜色字符串归一化为 sRGB hex。
 *
 * 支持：#rgb/#rgba/#rrggbb/#rrggbbaa（直通归一）、rgb()/rgba()（新旧语法）、
 * oklch(L C H[ / A])（转换）。其余写法（named、hsl、lab、color() 等）返回 null，
 * 调用方必须把 null 当作「不越过原生边界」处理，不得硬造兜底色。
 */
const cssColorToHex = (value: string): string | null => {
  const raw = value.trim();
  if (raw === '') return null;
  if (raw.startsWith('#')) return hexToNormalized(raw);
  const lower = raw.toLowerCase();
  if (lower.startsWith('oklch(')) return oklchToHex(lower);
  if (lower.startsWith('rgb')) return rgbToHex(lower);
  return null;
};

export = { cssColorToHex };
