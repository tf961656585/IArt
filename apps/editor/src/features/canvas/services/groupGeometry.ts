/**
 * 节点组几何常量与坐标契约。
 *
 * 这些常量是组节点派生尺寸（derived size）与组渲染组件（GroupNode）的共享单一事实源。
 * 派生尺寸 selector 与 GroupNode 必须引用本文件的常量，禁止各自硬编码，避免双线口径。
 *
 * 坐标契约（spec：docs/runtime/画布节点组.md「组节点尺寸与坐标契约」）：
 * - 组 position = 成员包围盒左上角 − (leftPadding, topPadding + headerHeight)
 * - 组 size = (包围盒宽 + leftPadding + rightPadding, 包围盒高 + topPadding + bottomPadding + headerHeight)
 * - header 区域位于成员区域之上，占组节点顶部 headerHeight 高度
 */

/** 展开态 header 高度（标题栏区域） */
export const GROUP_HEADER_HEIGHT = 32;

/** 成员区域与组边框之间的内边距 */
export const GROUP_PADDING = {
  top: 8,
  right: 12,
  bottom: 12,
  left: 12,
} as const;

/**
 * 折叠态卡片最小宽度（容纳组名 + 成员数徽章 + 舒适内边距的下限）。
 *
 * spec 要求折叠卡片有"块感"，最小宽度必须显著大于普通节点的窄标题条，
 * 让卡片在视觉上是一个独立的可读单元，不是 header 残骸。
 */
export const GROUP_COLLAPSED_MIN_WIDTH = 240;

/**
 * 折叠态卡片高度（独立于展开态 header 高度）。
 *
 * spec 要求卡片高度显著大于 header 高度（32）以体现块感；72 = header 32 + 40，
 * 给组名 + 成员数徽章留出充足内边距与舒展的视觉重量。折叠卡片承载组名 + 成员数徽章，
 * 不是 header 一条，高度独立裁定。
 */
export const GROUP_COLLAPSED_HEIGHT = 72;

/**
 * 根据成员节点的位置与尺寸，计算展开态组节点的派生 position。
 *
 * 坐标契约：position = 成员包围盒左上角 − (leftPadding, topPadding + headerHeight)。
 *
 * 此函数是组节点派生 position 的唯一算法 owner。投影层 derived selector 与
 * store 层成员位置更新（updateNodePositionsBatch）都必须调用本函数，禁止各自实现，
 * 否则两处算出的组 position 不一致会导致拖组位移错位。
 *
 * 成员尺寸由调用方传入（投影层传 actual 优先，store 层传 fallback），算法本身
 * 不关心尺寸来源，只保证给定相同成员几何产出相同 position。
 */
export const computeGroupExpandedPosition = (
  members: ReadonlyArray<{
    position: { x: number; y: number };
    size: { width: number; height: number } | null;
  }>,
): { x: number; y: number } | null => {
  if (members.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const member of members) {
    // 成员尺寸缺失时，用 position 作为单点参与包围盒（退化但保守）
    const left = member.position.x;
    const top = member.position.y;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX - GROUP_PADDING.left,
    y: minY - GROUP_PADDING.top - GROUP_HEADER_HEIGHT,
  };
};

/**
 * 折叠态 LOD 降级阈值（屏幕空间尺寸，单位 px）。
 *
 * 当折叠卡片的屏幕空间尺寸（画布尺寸 × viewport zoom）的宽或高低于此阈值时，
 * 渲染层降级为 LOD 锚点块。
 *
 * spec「折叠态 LOD 降级」：降级触发维度是屏幕空间尺寸，不是画布 zoom。
 * 同一 zoom 下不同画布尺寸的卡片降级状态可能不同——这是按屏幕可见性决定渲染细节的语义。
 */
export const GROUP_LOD_TRIGGER_SCREEN_SIZE = 80;

/**
 * LOD 锚点块屏幕固定尺寸（单位 px）。
 *
 * 降级后渲染的锚点块在屏幕上固定为此尺寸，不随画布 zoom 继续缩小，
 * 保证任何 zoom 级别下折叠组都可见、可识别、可点击。
 */
export const GROUP_LOD_ANCHOR_SCREEN_SIZE = 40;

/**
 * 展开态远缩放标题气泡触发阈值（屏幕空间尺寸，单位 px）。
 *
 * 展开组的屏幕空间宽或高低于此值时，在组框左上角显示固定屏幕尺寸的标题气泡
 * （组名 + 成员数），保证远缩放下展开组的上下文仍可读。
 * 气泡只是视图投影，不改变组 position、derived size 或成员事实。
 */
export const GROUP_EXPANDED_BUBBLE_TRIGGER_SCREEN_SIZE = 120;

/** 标题气泡屏幕高度（单位 px，屏幕空间固定，经 1/zoom 反向缩放承载） */
export const GROUP_EXPANDED_BUBBLE_SCREEN_HEIGHT = 20;

/** 标题气泡屏幕字号（单位 px） */
export const GROUP_EXPANDED_BUBBLE_FONT_SCREEN_SIZE = 11;

/**
 * LOD 锚点聚焦 zoom 反算下限。
 *
 * spec「折叠态 LOD 降级·锚点交互·聚焦脱离 LOD 不变量」（画布节点组.md）：
 * 点击 LOD 锚点定位后，目标组必须脱离 LOD 降级态，即聚焦后 zoom × 折叠卡片画布尺寸的
 * 每一维度 ≥ GROUP_LOD_TRIGGER_SCREEN_SIZE。聚焦 zoom 由 `computeLodAnchorLocateZoom`
 * 按该不变量反算得出，本常量是反算值的下限——反算结果低于此值时取此值。
 *
 * 取值 1，与 useLocateToNode 的默认 zoom 一致：当折叠卡片画布尺寸已远大于 LOD 阈值
 * （反算值 < 1）时，聚焦 zoom 不低于定位主口径默认值，避免聚焦后视口比默认更远。
 */
export const GROUP_LOD_LOCATE_ZOOM = 1;

/**
 * 计算点击 LOD 锚点聚焦时，保证目标组脱离 LOD 降级态所需的 zoom。
 *
 * spec「折叠态 LOD 降级·锚点交互·聚焦脱离 LOD 不变量」（画布节点组.md）：
 * 聚焦后 zoom × 折叠卡片画布尺寸的每一维度必须 ≥ GROUP_LOD_TRIGGER_SCREEN_SIZE。
 * 本函数是该不变量的可执行表达：取卡片宽高的较小值（最受限维度），反算出使其屏幕尺寸
 * 恰好达到阈值所需的 zoom；反算值低于 GROUP_LOD_LOCATE_ZOOM（默认 1）时取下限。
 *
 * 调用方传入手持的折叠卡片画布尺寸（GroupNode 组件的派生 width/height props）；
 * 尺寸未收敛（初渲染 undefined）时由调用方兜底为折叠卡片常量（GROUP_COLLAPSED_MIN_WIDTH /
 * GROUP_COLLAPSED_HEIGHT），不在此函数内兜底，保持纯函数职责单一。
 *
 * 返回值直接作为 useLocateToNode 的 zoom override（LOD 锚点点击是定位主抽象的显式入口，
 * 传 zoom override 不改变居中主口径，不引入 fitView）。
 */
export const computeLodAnchorLocateZoom = (
  cardWidth: number,
  cardHeight: number,
): number => {
  const limiting = Math.min(cardWidth, cardHeight);
  if (limiting <= 0) {
    return GROUP_LOD_LOCATE_ZOOM;
  }
  const required = GROUP_LOD_TRIGGER_SCREEN_SIZE / limiting;
  return Math.max(GROUP_LOD_LOCATE_ZOOM, required);
};
