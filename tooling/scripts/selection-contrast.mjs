#!/usr/bin/env node
// 选中态凹边峰值质检（docs/ui-selection-standard.md §9.2）。
//
// 计算 color-mix / box-shadow alpha 合成后的 WCAG 对比度。关键：CSS 的
// color-mix(in srgb, …) 与 box-shadow alpha 合成发生在 gamma 编码的 sRGB 空间；
// 先混线性 RGB 会算错（浅色暗影被算低、深色亮边被算高）。
//
// 用法：
//   node selection-contrast.mjs \
//     --bg "0.95 0.03 277" --fg "0.30 0.13 277" \
//     --depth-alpha 0.66 [--depth-color fg|black] \
//     --edge white:0.82 [--floor 2.5]
//   --edge 取值 white:α | fg:α | black:α；depth-color 缺省 fg。
// 退出码：峰值低于 floor 时为 1，可直接用于门禁。

function oklchToLinear(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}

const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const srgbOf = (L, C, H) => oklchToLinear(L, C, H).map(linToSrgb);
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(srgbToLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const parseOklch = (text) => text.trim().split(/\s+/).map(Number);
if (!args.bg || !args.fg || !args["depth-alpha"] || !args.edge) {
  console.error(
    '用法: node selection-contrast.mjs --bg "L C H" --fg "L C H" --depth-alpha 0.66 '
      + '[--depth-color fg|black] --edge white:0.82 [--floor 2.5]',
  );
  process.exit(2);
}
const bg = srgbOf(...parseOklch(args.bg));
const fg = srgbOf(...parseOklch(args.fg));
const depthColor = args["depth-color"] ?? "fg";
const depthBase = depthColor === "black" ? [0, 0, 0] : fg;
const [edgeColor, edgeAlphaText] = args.edge.split(":");
const depthAlpha = Number(args["depth-alpha"]);
const edgeAlpha = Number(edgeAlphaText);
if (![bg, fg, depthAlpha, edgeAlpha].every((value) => Array.isArray(value) ? value.every(Number.isFinite) : Number.isFinite(value))) {
  console.error("参数里的 OKLCH 三元组或 alpha 不是合法数字");
  process.exit(2);
}
const edgeBase = edgeColor === "white" ? [1, 1, 1] : edgeColor === "black" ? [0, 0, 0] : fg;
const top = contrast(over(depthBase, bg, depthAlpha), bg);
const bottom = contrast(over(edgeBase, bg, edgeAlpha), bg);
const peak = Math.max(top, bottom);
const floor = Number(args.floor ?? 2.5);
console.log(`顶部暗影 ${top.toFixed(2)}:1 / 底部亮边 ${bottom.toFixed(2)}:1`);
console.log(`凹边峰值 ${peak.toFixed(2)}:1 → ${peak >= floor ? "PASS" : "FAIL"}（floor ${floor}:1）`);
process.exit(peak >= floor ? 0 : 1);
