/**
 * 节点组调色板。
 *
 * 承载组色（GroupNodeData.color）的取色策略：稳定调色板 + 按 id 哈希映射。
 *
 * 设计意图：组色是折叠卡片与 LOD 锚点块的视觉锚点，必须满足
 *   - 同一个组在重新打开工程后颜色不变（稳定，由 id 决定，不随机）
 *   - 相邻创建的组颜色有差异（调色板按 id 哈希散列，避免连续 id 落到同色）
 *   - 调色板色相对画布背景与选中态蓝色都有足够区分度
 *
 * 调色板是组色的唯一取色事实源；渲染层不得各自硬编码颜色字面量。
 *
 * 三档结构（对齐 visual-design.md §5.5 状态色三档模式）：
 *   - base：持久化到 GroupNodeData.color 的 500 档组色，只做底色/边框，禁止直接做文字色
 *   - textLight / textDark：浅色/深色主题下压在组色淡底上的文字档
 *     （浅色取 700 档、深色取 300 档，对各自 10% 组色淡底 ≥4.5:1）
 */

export type GroupPaletteEntry = {
  /** 持久化组色（500 档，只做底/边框） */
  base: string;
  /** 浅色主题文字档 */
  textLight: string;
  /** 深色主题文字档 */
  textDark: string;
};

/**
 * 组色调色板。
 *
 * 选取原则：色相分散（避免相邻 id 落到接近色）、饱和度适中（不刺眼，但缩放到 LOD 锚点块时仍可识别）、
 * 明度适中（在浅色画布背景上有足够对比）。具体色值由实现层裁定，后续可调整。
 */
const GROUP_PALETTE: readonly GroupPaletteEntry[] = [
  { base: '#5B8DEF', textLight: '#1d4ed8', textDark: '#93c5fd' }, // 蓝
  { base: '#22C55E', textLight: '#15803d', textDark: '#86efac' }, // 绿
  { base: '#F59E0B', textLight: '#b45309', textDark: '#fcd34d' }, // 琥珀
  { base: '#EC4899', textLight: '#be185d', textDark: '#f9a8d4' }, // 粉
  { base: '#8B5CF6', textLight: '#6d28d9', textDark: '#c4b5fd' }, // 紫
  { base: '#14B8A6', textLight: '#0f766e', textDark: '#5eead4' }, // 青
  { base: '#EF4444', textLight: '#b91c1c', textDark: '#fca5a5' }, // 红
  { base: '#6366F1', textLight: '#4338ca', textDark: '#a5b4fc' }, // 靛
];

/** base HEX → 文字档索引（getGroupTextColors 用 O(1) 查找） */
const TEXT_TIER_BY_BASE = new Map<string, GroupPaletteEntry>(
  GROUP_PALETTE.map((entry) => [entry.base.toLowerCase(), entry]),
);

/** 未知持久化组色（历史数据改过色值等）的文字档兜底：中性前景色，任何淡底上可读 */
const NEUTRAL_TEXT_FALLBACK: GroupPaletteEntry = {
  base: '',
  textLight: '#1f2430',
  textDark: '#f5f5f5',
};

/**
 * 默认组色（id 缺失或哈希退化时的兜底，取调色板首色）。
 *
 * 显式标注为 string，避免 readonly tuple 的 indexed access 被推断为字面量联合，
 * 让消费方（GroupNodeData.color: string | undefined）能直接接收。
 */
export const GROUP_DEFAULT_COLOR: string = GROUP_PALETTE[0]?.base ?? '#5B8DEF';

/** 调色板全部 base 色（换色器等按色枚举的消费方使用；与 GROUP_PALETTE 同源派生） */
export const GROUP_PALETTE_COLORS: readonly string[] = GROUP_PALETTE.map(
  (entry) => entry.base,
);

/**
 * 按持久化组色 HEX 查配套文字档。
 *
 * 渲染层用返回值注入 --group-text-light / --group-text-dark 内联变量，
 * 由 CSS 按 [data-theme] 切换；未知 HEX 回退中性前景档，保证任何历史数据可读。
 */
export const getGroupTextColors = (baseColor: string): { textLight: string; textDark: string } => {
  const entry = TEXT_TIER_BY_BASE.get(baseColor.toLowerCase());
  if (entry) {
    return { textLight: entry.textLight, textDark: entry.textDark };
  }
  return { textLight: NEUTRAL_TEXT_FALLBACK.textLight, textDark: NEUTRAL_TEXT_FALLBACK.textDark };
};

/**
 * 字符串 → 32 位正整数的稳定哈希（djb2 变体）。
 *
 * 仅用于把 group id 散列到调色板槽位，不需要密码学强度；
 * 必须是确定性的（同 id 永远产出同值），保证工程重新打开后组色不变。
 */
const hashString = (value: string): number => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/**
 * 根据 group id 从调色板取一个稳定色（持久化 base HEX）。
 *
 * - id 非空：哈希后取模落到调色板槽位，保证同 id 稳定、相邻 id 散列分散。
 * - id 为空或异常：回退到 GROUP_DEFAULT_COLOR。
 *
 * 此函数是"为组生成默认色"的唯一入口；createDefaultGroupNodeData 必须经此函数取色，
 * 不得自行 Math.random 或硬编码。
 */
export const pickGroupColorById = (groupId: string | undefined): string => {
  if (typeof groupId !== 'string' || groupId.length === 0) {
    return GROUP_DEFAULT_COLOR;
  }
  const index = hashString(groupId) % GROUP_PALETTE.length;
  return GROUP_PALETTE[index]?.base ?? GROUP_DEFAULT_COLOR;
};
